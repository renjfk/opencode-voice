"""Start the VieNeu OpenAI-compatible speech server for opencode-voice.

The plugin spawns this with an explicit private working directory and the
HOST/PORT environment variables. It never adds the working directory to
sys.path, so a user's project cannot shadow installed packages.

Two fixes are applied to the stock app:

* ONNX Runtime >= 1.31 rejects model files whose external data is reached
  through Hugging Face cache symlinks, so model files are materialized as real
  files (hard link, else copy) in one temporary directory per fetch.
* When a client disconnects mid-stream (the plugin stops speech), Starlette
  abandons the sync body generator without closing it, so the stream slot is
  never released and every later request gets 429 "server busy". The body is
  wrapped so it is always closed and the slot always released.
"""

import os
import shutil
import signal
import sys
import tempfile
import threading
from pathlib import Path


def server_address():
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    return host, port


def materialize(source, files, destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for name in files:
        if Path(name).name != name:
            raise ValueError("Model filenames must not contain directories")
        src = Path(source) / name
        if not src.is_file():
            continue
        dst = destination / name
        try:
            os.link(src.resolve(), dst)
        except OSError:
            shutil.copyfile(src, dst)
    return destination


class SlotChunks:
    """Speech chunk iterator that releases its stream slot exactly once.

    The stock generator releases the slot in a ``finally`` block, which never
    runs when the generator is closed before it started.
    """

    def __init__(self, engine, inner):
        self.engine = engine
        self.inner = inner
        self.started = False

    def __iter__(self):
        return self

    def __next__(self):
        self.started = True
        return next(self.inner)

    def close(self):
        # A started generator releases in its own finally (run by close() if
        # suspended, already run if finished); an unstarted one never will.
        self.inner.close()
        if not self.started:
            self.engine.release()


class ClosingBody:
    """Sync body iterator whose close() waits for the in-flight next()."""

    def __init__(self, body, chunks):
        self.body = body
        self.chunks = chunks
        self.lock = threading.Lock()
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        with self.lock:
            if self.closed:
                raise StopIteration
            return next(self.body)

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            try:
                self.body.close()
            finally:
                if self.chunks is not None:
                    self.chunks.close()


def patch_streaming(module):
    """Make apps.openai_speech release stream slots on client disconnect."""
    original_chunks = getattr(module, "_speech_chunks", None)
    base = getattr(module, "StreamingResponse", None)
    if original_chunks is None or base is None:
        return False
    import anyio

    # speech() is synchronous: it builds the chunks and then the response in
    # the same thread, so a thread-local hands one to the other.
    pending = threading.local()

    def speech_chunks(engine, req, rid):
        chunks = SlotChunks(engine, original_chunks(engine, req, rid))
        pending.chunks = chunks
        return chunks

    class ClosingStreamingResponse(base):
        def __init__(self, content, *args, **kwargs):
            chunks = getattr(pending, "chunks", None)
            pending.chunks = None
            self._closing_body = None
            if hasattr(content, "__next__"):
                content = ClosingBody(content, chunks)
                self._closing_body = content
            super().__init__(content, *args, **kwargs)

        async def __call__(self, scope, receive, send):
            try:
                await super().__call__(scope, receive, send)
            finally:
                if self._closing_body is not None:
                    with anyio.CancelScope(shield=True):
                        await anyio.to_thread.run_sync(self._closing_body.close)

    module._speech_chunks = speech_chunks
    module.StreamingResponse = ClosingStreamingResponse
    return True


def run_stock_app(host, port):
    """Older VieNeu without the ONNX lite engine: run its app module as-is."""
    env = dict(os.environ, HOST=host, PORT=str(port))
    os.execve(sys.executable, [sys.executable, "-m", "apps.openai_speech"], env)


def main():
    # Python puts this script's directory first on sys.path; it holds only
    # plugin sources, never packages, so drop it to keep imports clean.
    script_dir = os.path.dirname(os.path.abspath(__file__))
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != script_dir]

    host, port = server_address()
    try:
        from vieneu._v3_turbo_engine.onnx_runtime_lite import OnnxV3LiteEngine
    except ModuleNotFoundError as error:
        if not (error.name or "").startswith("vieneu"):
            raise
        run_stock_app(host, port)
        return

    import uvicorn

    original = OnnxV3LiteEngine._fetch

    def terminate(_signal, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    with tempfile.TemporaryDirectory(prefix="opencode-vieneu-") as temp:
        counter = 0

        def fetch(repo, files, subfolder):
            nonlocal counter
            source = original(repo, files, subfolder)
            counter += 1
            return materialize(source, files, Path(temp) / str(counter))

        OnnxV3LiteEngine._fetch = staticmethod(fetch)
        import apps.openai_speech as speech_app

        if not patch_streaming(speech_app):
            print("opencode-voice: stream slot patch not applied", file=sys.stderr)
        uvicorn.run(speech_app.app, host=host, port=port, workers=1, log_level="warning")


if __name__ == "__main__":
    main()
