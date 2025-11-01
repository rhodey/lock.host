#!/bin/bash
set -e

# for dev / local testing compute a hash to be used in attest docs
dirs=("/app" "/bin" "/etc" "/home" "/lib" "/opt" "/root" "/runtime" "/sbin" "/srv" "/usr" "/var")
for dir in "${dirs[@]}"; do
  find $dir -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum >> /hash.txt
done

total=$(cat /hash.txt | sha256sum | awk '{ printf $1 }')
echo -n $total > /hash.txt
