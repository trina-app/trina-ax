# API engine reads images; connector writes up to 10M characters; delete and access cards without a count cap

- Date (UTC): 2026-11-18 21:58
- Branch: `fix/api-images-connector-cap-delete-cards`
- Status: done
- Where: Team AX core (server engine, connections, chat tools; web card). Why: chat, AI connection and permission code lives in the core (docs/REPOSITORY-RULES.md)
- Version impact: patch: limits raised and refusals turned into cards, no new feature surface beyond one admin choice

## Goal

The owner's rule: Claude Code is the floor. Three gaps from the limits audit (items 31, N25, N20):

- F. A team on the API engine (OpenRouter, Ollama, LM Studio …) never shows pictures to the model. Claude Code does.
- K. A write through a connected service stops at 100,000 characters. Claude Code has no such cap.
- H. Delete is refused in any chat that read room messages or shared files; delete, members and folder-access cards
  stop after 2-3 per answer. Claude Code asks every time and has no count cap.

## Scope

In:
- F: detect from the model's own server whether it takes images (OpenRouter /models input_modalities, Ollama /api/show
  capabilities, LM Studio type vlm, llama.cpp /props modalities, known models of the official OpenAI / Gemini / Anthropic
  endpoints). A model that takes images gets the pictures that read, room_file and the connection tools give, as image
  parts of a user message after the tool results. Unknown: an admin choice in the API engine form ("Reads pictures":
  automatic / yes / no) that counts only while detection is unknown. A model that does not take images: one plain note,
  the text path as today.
- K: MAX_CARD_PAYLOAD 100,000 -> 10,000,000. A card detail longer than CARD_TEXT_INLINE carries its start; the full text
  stays on the server with the open card and opens on request (GET /api/turns/:id/requests/:requestId/details/:index).
- H: delete_files in a chat that read rooms or a shared file: the card every time (no Always allow skip there), with
  the room line first. No per-answer card count for delete, members and folder access. change_folder_access takes a
  list of changes (`changes`) shown on one card.

Out: one card across several separate calls (calls of one answer are serialized by the gate, so they cannot be joined
without a wait); members of several projects on one card.

## Steps

1. Plan (this file).
2. K: cap, folded card detail with the full text on request, route, web card.
3. H: delete refusal, caps removed, folder access list form, descriptions.
4. F: engine/api-vision.ts, visionBlock per turn, api-agent image parts, admin choice, words.
5. Tests, decision file, changes note, QA rows.

## Decisions

docs/decisions/20261118-api-images-connector-cap-delete-cards.md

## Result

Built as planned. Real-AI check on a copy of the QA team: in a side chat the AI deleted three notes with one
call and one card (room line first); an admin's "give two people view access" became one `changes` call on one card;
the API engine on Ollama qwen3-vl:2b (detected from /api/show) read a PNG and named its colour.
