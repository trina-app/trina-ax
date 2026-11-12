package main

// tests that write a roll-back into state.json expect `update` to report it at once
func init() { rollbackGrace = 0 }
