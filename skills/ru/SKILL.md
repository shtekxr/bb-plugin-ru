---
name: ru
description: Russian UI translation plugin for bb; dictionary lives in dictionary.json
---
The plugin translates visible UI text via a content script (app.tsx) using dictionary.json (exact English string -> Russian). Untranslated strings seen in the UI are collected in localStorage key `bb-ru-missing` and should be added to dictionary.json.
