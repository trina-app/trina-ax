#!/bin/bash
# Dev environment on srt: run vm-check.sh on a throwaway EC2 VM (docs/research/srt-dev-env.md 10.3), then delete
# everything and show that nothing is left. One t3a.medium (the Starter size), Debian 13, in the Trina test account.
#   - AWS profile "trina" only (account 896568317806, ap-northeast-2). The script stops on any other account.
#   - No key pair and no IAM: a new SSH key goes to the VM in its user data.
#   - The VM, its volume and its security group carry the tag trina-test=srt-spike. The teardown runs on every exit.
# Usage, from the repo root (commit or keep the files you want to test; untracked files are sent too):
#   scripts/dev-env/srt/spike-vm.sh [log-file] [checks|bench]
set -euo pipefail
PROFILE=trina
REGION=ap-northeast-2
ACCOUNT=896568317806
TAG_KEY=trina-test
TAG_VAL=srt-spike
TYPE=t3a.medium
DEBIAN_OWNER=136693071363
BUN_VERSION=1.3.12
LOG=${1:-srt-spike-vm.log}
MODE=${2:-checks}
aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }
say() { echo "spike-vm: $*" >&2; }

[ "$(aws_ sts get-caller-identity --query Account --output text)" = "$ACCOUNT" ] || { say "STOP: profile $PROFILE is not account $ACCOUNT"; exit 1; }
LIVE=$(aws_ ec2 describe-instances --filters "Name=tag:$TAG_KEY,Values=$TAG_VAL" "Name=instance-state-name,Values=pending,running,stopping,stopped" --query 'Reservations[].Instances[].InstanceId' --output text)
[ -z "$LIVE" ] || { say "STOP: a spike VM already exists: $LIVE (one at a time)"; exit 1; }

WORK=$(mktemp -d)
IID= SG=
cleanup() {
  set +e
  if [ -n "$IID" ]; then
    say "terminating $IID"
    aws_ ec2 terminate-instances --instance-ids "$IID" >/dev/null
    aws_ ec2 wait instance-terminated --instance-ids "$IID"
  fi
  if [ -n "$SG" ]; then
    for _ in 1 2 3 4 5 6; do aws_ ec2 delete-security-group --group-id "$SG" 2>/dev/null && break; sleep 10; done
  fi
  # left volumes with the tag (DeleteOnTermination should leave none)
  for v in $(aws_ ec2 describe-volumes --filters "Name=tag:$TAG_KEY,Values=$TAG_VAL" --query 'Volumes[].VolumeId' --output text); do aws_ ec2 delete-volume --volume-id "$v"; done
  say "proof (tag $TAG_KEY=$TAG_VAL):"
  echo "instances not terminated: [$(aws_ ec2 describe-instances --filters "Name=tag:$TAG_KEY,Values=$TAG_VAL" "Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped" --query 'Reservations[].Instances[].InstanceId' --output text)]" >&2
  echo "all instances: $(aws_ ec2 describe-instances --filters "Name=tag:$TAG_KEY,Values=$TAG_VAL" --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output text | tr '\n\t' '; ')" >&2
  echo "volumes: [$(aws_ ec2 describe-volumes --filters "Name=tag:$TAG_KEY,Values=$TAG_VAL" --query 'Volumes[].VolumeId' --output text)]" >&2
  echo "security groups: [$(aws_ ec2 describe-security-groups --filters "Name=tag:$TAG_KEY,Values=$TAG_VAL" --query 'SecurityGroups[].GroupId' --output text)]" >&2
  rm -rf "$WORK"
}
trap cleanup EXIT

ssh-keygen -q -t ed25519 -N '' -C srt-spike -f "$WORK/key"
AMI=$(aws_ ec2 describe-images --owners "$DEBIAN_OWNER" --filters 'Name=name,Values=debian-13-amd64-*' 'Name=architecture,Values=x86_64' 'Name=state,Values=available' --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)
VPC=$(aws_ ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
MYIP=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
say "AMI $AMI, VPC $VPC, SSH from $MYIP/32"
TAGS="{Key=$TAG_KEY,Value=$TAG_VAL},{Key=Name,Value=trina-srt-spike}"
SG=$(aws_ ec2 create-security-group --group-name "trina-srt-spike-$(date +%s)" --description 'srt spike: ssh from one address' --vpc-id "$VPC" \
  --tag-specifications "ResourceType=security-group,Tags=[$TAGS]" --query GroupId --output text)
aws_ ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22 --cidr "$MYIP/32" >/dev/null
printf '#cloud-config\nssh_authorized_keys:\n  - %s\n' "$(cat "$WORK/key.pub")" > "$WORK/user-data"
IID=$(aws_ ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --security-group-ids "$SG" --count 1 \
  --user-data "file://$WORK/user-data" --metadata-options HttpTokens=required,HttpEndpoint=enabled \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}' \
  --tag-specifications "ResourceType=instance,Tags=[$TAGS]" "ResourceType=volume,Tags=[$TAGS]" \
  --query 'Instances[0].InstanceId' --output text)
say "instance $IID"
aws_ ec2 wait instance-running --instance-ids "$IID"
IP=$(aws_ ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
SSH=(ssh -i "$WORK/key" -o ServerAliveInterval=30 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 "admin@$IP")
for _ in $(seq 1 40); do "${SSH[@]}" true 2>/dev/null && break; sleep 5; done
say "ssh to $IP is up; sending the repo"

# the repo as it is in this folder (tracked and untracked files, no ignored ones)
git ls-files -co --exclude-standard -z | tar --null -T - -czf "$WORK/repo.tgz"
"${SSH[@]}" 'sudo install -d -m 755 /opt/mycel'
"${SSH[@]}" 'sudo tar -xzf - -C /opt/mycel --no-same-owner' < "$WORK/repo.tgz"
"${SSH[@]}" bash -s "$BUN_VERSION" <<'EOF' 2>&1 | tail -5
set -euo pipefail
V=$1
sudo apt-get update -q >/dev/null && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q unzip curl jq >/dev/null
cd /tmp
curl -fsSL -o bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v$V/bun-linux-x64.zip"
curl -fsSL -o SHASUMS256.txt "https://github.com/oven-sh/bun/releases/download/bun-v$V/SHASUMS256.txt"
grep ' bun-linux-x64.zip$' SHASUMS256.txt | sed 's/bun-linux-x64.zip/bun.zip/' | sha256sum -c -
unzip -oq bun.zip && sudo install -o root -g root -m 755 bun-linux-x64/bun /usr/local/bin/bun
cd /opt/mycel && sudo HOME=/root /usr/local/bin/bun install --frozen-lockfile --ignore-scripts >/dev/null
sudo chown -R root:root /opt/mycel && sudo chmod -R go-w /opt/mycel
echo "bun $(/usr/local/bin/bun --version), repo ready"
EOF
say "CPU credits: $(aws_ ec2 describe-instance-credit-specifications --instance-ids "$IID" --query 'InstanceCreditSpecifications[0].CpuCredits' --output text)"
say "running vm-check.sh $MODE (checks: 10 to 20 minutes; bench: about 40 minutes); log: $LOG"
set +e
"${SSH[@]}" "sudo /opt/mycel/scripts/dev-env/srt/vm-check.sh /opt/mycel $MODE" 2>&1 | tee "$LOG"
CODE=${PIPESTATUS[0]}
"${SSH[@]}" 'free -m; systemctl --version | head -1; uname -r; lscpu | grep -E "Model name|^CPU\(s\)"' 2>&1 | tee -a "$LOG"
set -e
say "vm-check exit code $CODE"
exit "$CODE"
