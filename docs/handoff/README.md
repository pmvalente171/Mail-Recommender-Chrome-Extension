# Assistente DALM · hand-off package

1. Unzip this folder into the repository where the extension will live, for example as `docs/handoff/`.
2. Open `prototype.html` in a browser to try the intended interface. The top bar jumps between the six reference states.
3. Start Claude Code in the repository and give it a first prompt like this:

> Read @docs/handoff/HANDOFF.md and @docs/handoff/prototype.html. We are building the Chrome extension (Manifest V3) described there, for Gmail. Follow the non-negotiable rules in section 2 strictly. Start with step 1 of the build order in section 11, and stop after it so I can test. Ask me before choosing between InboxSDK, our own DOM injection or the Side Panel API (section 3).

Then go one build step at a time, testing each before moving on.
