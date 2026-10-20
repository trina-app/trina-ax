package peer

// TCPOwner finds the local process that owns the client end of a loopback TCP connection
// (clientPort -> serverPort). Must run as the engine account: other users' processes are not visible (EPERM).
func TCPOwner(clientPort, serverPort int) (int, error) { return tcpOwner(clientPort, serverPort) }
