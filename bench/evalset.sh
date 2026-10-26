#!/bin/sh
sleep 300 &
echo $! > "$TMPDIR/sleep.pid"
wait
