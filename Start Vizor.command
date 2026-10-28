#!/bin/sh
cd "$(dirname "$0")" || exit 1
sh ./start-vizor.sh "$@"
vizor_result=$?
if [ "$vizor_result" -ne 0 ]; then
  printf '\n%s\n' 'Vizor could not start. Read the message above. Press Enter to close.'
  read -r vizor_reply
fi
exit "$vizor_result"
