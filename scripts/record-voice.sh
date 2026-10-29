#!/usr/bin/env bash
set -u
SESSION="voice-$$"
CAST="$1"
WDIR="${2:-/Users/duytrinh/Code/opencode-voice}"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 120 -y 36 -c "$WDIR" 'opencode'
sleep 7
asciinema rec -c "tmux attach -t $SESSION" --window-size 120x36 --overwrite "$CAST" >/tmp/scratchpad/asciilog 2>&1 &
REC_PID=$!
sleep 2
# run expect inside tmux? Instead send via tmux send-keys reading expect file not possible.
# We'll just send a minimal sequence via tmux instead of expect.
tmux send-keys -t "$SESSION" C-p
sleep 2
tmux send-keys -t "$SESSION" "stt record"
sleep 2
tmux send-keys -t "$SESSION" Enter
sleep 6
tmux send-keys -t "$SESSION" C-p
sleep 1
tmux send-keys -t "$SESSION" "stt stop"
sleep 1
tmux send-keys -t "$SESSION" Enter
sleep 3
tmux send-keys -t "$SESSION" C-p
sleep 1
tmux send-keys -t "$SESSION" "voice conversation"
sleep 1
tmux send-keys -t "$SESSION" Enter
sleep 5
tmux send-keys -t "$SESSION" C-p
sleep 1
tmux send-keys -t "$SESSION" "voice conversation stop"
sleep 1
tmux send-keys -t "$SESSION" Enter
sleep 3
tmux send-keys -t "$SESSION" C-c
sleep 2
tmux kill-session -t "$SESSION" 2>/dev/null || true
wait $REC_PID 2>/dev/null || true
echo done
