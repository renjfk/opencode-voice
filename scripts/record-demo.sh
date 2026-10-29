#!/usr/bin/env bash
set -u
SESSION="ocdemo2-$$"
CAST="$1"
WDIR="${2:-/tmp/scratchpad}"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 120 -y 36 -c "$WDIR" 'opencode'
sleep 7
asciinema rec -c "tmux attach -t $SESSION" --window-size 120x36 --overwrite "$CAST" >/tmp/scratchpad/asciilog 2>&1 &
REC_PID=$!
sleep 2
# Show voice commands
tmux send-keys -t "$SESSION" C-p
sleep 2
tmux send-keys -t "$SESSION" "voice"
sleep 2.5
tmux send-keys -t "$SESSION" Escape
sleep 1
# Show STT commands
tmux send-keys -t "$SESSION" C-p
sleep 2
tmux send-keys -t "$SESSION" "stt"
sleep 2.5
tmux send-keys -t "$SESSION" Escape
sleep 1
# Show TTS commands
tmux send-keys -t "$SESSION" C-p
sleep 2
tmux send-keys -t "$SESSION" "tts"
sleep 2.5
tmux send-keys -t "$SESSION" Escape
sleep 1
# Show conversation command
tmux send-keys -t "$SESSION" C-p
sleep 2
tmux send-keys -t "$SESSION" "conversation"
sleep 2.5
tmux send-keys -t "$SESSION" Escape
sleep 1
tmux send-keys -t "$SESSION" C-c
sleep 2
tmux kill-session -t "$SESSION" 2>/dev/null || true
wait $REC_PID 2>/dev/null || true
echo "done"
