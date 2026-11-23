#!/usr/bin/env bash
# Deploy the room email mailbox on AWS (mailbox-ses/README.md). Idempotent: run it again after a code change.
#   AWS_PROFILE=engine-trina mailbox-ses/deploy.sh
# Before the first run: the SSM SecureString $TOKEN_PARAM must exist (README "First deploy", step 2).
# It never prints or passes a secret: the token is only read by the API function at run time.
set -euo pipefail
cd "$(dirname "$0")"

REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-room-email}"
RULE_SET="${RULE_SET:-room-email}"
TOKEN_PARAM="${TOKEN_PARAM:-/room-email/cp-lookup-token}"
MAIL_DOMAIN="${MAIL_DOMAIN:-in.trina.app}"
CP_TEAMS_URL="${CP_TEAMS_URL:-https://cp.trina.app/internal/mail-in/team}"
TAG=purpose=room-email
export AWS_REGION="$REGION"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "account $ACCOUNT, region $REGION, stack $STACK"
[ "${EXPECT_ACCOUNT:-896568317806}" = "$ACCOUNT" ] || { echo "not the expected account (EXPECT_ACCOUNT)" >&2; exit 1; }

aws ssm get-parameter --name "$TOKEN_PARAM" --query Parameter.Type --output text >/dev/null \
  || { echo "SSM parameter $TOKEN_PARAM is missing (README First deploy step 2)" >&2; exit 1; }

# 1. the bundle
bun build src/lambda.ts --target=node --format=esm --outfile dist/index.mjs >/dev/null
SHA="$(shasum -a 256 dist/index.mjs | cut -c1-16)"
( cd dist && rm -f lambda.zip && zip -q -X lambda.zip index.mjs )

# 2. the code bucket (private, encrypted, tagged)
CODE_BUCKET="room-email-artifacts-$ACCOUNT-$REGION"
if ! aws s3api head-bucket --bucket "$CODE_BUCKET" 2>/dev/null; then
  if [ "$REGION" = us-east-1 ]; then aws s3api create-bucket --bucket "$CODE_BUCKET" >/dev/null
  else aws s3api create-bucket --bucket "$CODE_BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null; fi
  aws s3api put-public-access-block --bucket "$CODE_BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption --bucket "$CODE_BUCKET" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-bucket-tagging --bucket "$CODE_BUCKET" --tagging 'TagSet=[{Key=purpose,Value=room-email}]'
  echo "created s3://$CODE_BUCKET"
fi
CODE_KEY="mailbox-ses/$SHA.zip"
aws s3 cp --quiet dist/lambda.zip "s3://$CODE_BUCKET/$CODE_KEY"

# 3. the stack
aws cloudformation deploy --stack-name "$STACK" --template-file template.yaml \
  --capabilities CAPABILITY_NAMED_IAM --tags "$TAG" --no-fail-on-empty-changeset \
  --parameter-overrides "MailDomain=$MAIL_DOMAIN" "CpTeamsUrl=$CP_TEAMS_URL" "CpTokenParam=$TOKEN_PARAM" \
    "CodeBucket=$CODE_BUCKET" "CodeKey=$CODE_KEY" "RuleSetName=$RULE_SET"

# 4. the active receipt rule set: one per region. Ours, or none yet; never replace another one.
ACTIVE="$(aws ses describe-active-receipt-rule-set --query Metadata.Name --output text 2>/dev/null || true)"
if [ -z "$ACTIVE" ] || [ "$ACTIVE" = None ]; then
  aws ses set-active-receipt-rule-set --rule-set-name "$RULE_SET"
  echo "activated receipt rule set $RULE_SET"
elif [ "$ACTIVE" != "$RULE_SET" ]; then
  echo "another receipt rule set is active ($ACTIVE): add the rule to it by hand, or decide first" >&2; exit 1
fi

aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
echo "code: s3://$CODE_BUCKET/$CODE_KEY"
