package main

// openBeneath opens parts below dirfd one component at a time with O_NOFOLLOW (intermediate ones also O_DIRECTORY):
// a link anywhere fails the open instead of being followed. ".." never gets here (splitRel refuses it).
func openBeneath(dirfd int, parts []string, flags int, mode uint32) (int, error) {
	return walkOpen(dirfd, parts, flags, mode)
}
