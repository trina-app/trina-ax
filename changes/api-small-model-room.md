- With a small local AI model (an API connection to Ollama or LM Studio), Trina keeps the newest messages of the chat
  and no longer refuses a 16k model as too small. It now leaves out the instructions for tools that model was not given.
