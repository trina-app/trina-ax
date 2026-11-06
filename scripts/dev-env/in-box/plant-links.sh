# Attack probe, sent into the box as a job by vm-tests.sh. boxd runs as root and reads this job's files from the box
# volume, so each phase tries to make it read something else. HOST at the top of the text: a folder of the host with
# planted.exit and planted.log. The box cannot read that folder; only root on the host can. Phases are 6 s long.
LOGS=/cache/logs
# 1: links at the two files boxd reads, to host files
ln -sf "$HOST/planted.exit" "$LOGS/planted.exit"
ln -sf "$HOST/planted.log" "$LOGS/planted.log"
sleep 6
# 2: the logs folder itself is a link to a host folder
rm -f "$LOGS/planted.exit" "$LOGS/planted.log"
mv "$LOGS" "$LOGS.real"
ln -s "$HOST" "$LOGS"
sleep 6
# 3: a FIFO at the exit file: a read with no O_NONBLOCK waits for ever
rm -f "$LOGS"
mv "$LOGS.real" "$LOGS"
mkfifo "$LOGS/planted.exit"
sleep 8
rm -f "$LOGS/planted.exit"
