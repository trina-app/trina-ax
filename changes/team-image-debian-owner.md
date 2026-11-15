- The new-team server image build could not start: the role's "Debian image only" rule checked Debian's account id
  for both the image and its snapshot. AWS reports a public Amazon-listed image's `ec2:Owner` as `amazon`, while its
  snapshot reports the owning account id. The reviewed policy (`docs/runbooks/team-image-iam-policy.json`) now has two
  rules: the builder from a public `amazon` image, the work volume from a Debian (136693071363) snapshot. The build
  script still picks the AMI by Debian's owner id.
