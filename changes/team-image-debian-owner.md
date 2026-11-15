- The new-team server image build could not start its builder: AWS reports `ec2:Owner` as `amazon` (not Debian's
  account id) for a public Amazon-listed AMI, so the role's "Debian image only" rule never matched. The reviewed policy
  (`docs/runbooks/team-image-iam-policy.json`) now checks `ec2:Owner` `amazon` and `ec2:Public` `true`; the build
  script still picks the AMI by Debian's owner id 136693071363.
