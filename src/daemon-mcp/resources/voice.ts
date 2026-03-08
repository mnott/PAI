export const voice = {
  name: "voice",
  uri: "pai://voice",
  description: "Voice system reference — server management and voice IDs",
  content: `# Voice System Reference

## Voice Server Quick Reference

Start: \${PAI_DIR}/voice-server/start.sh
Status: \${PAI_DIR}/voice-server/status.sh
Restart: \${PAI_DIR}/voice-server/restart.sh
Stop: \${PAI_DIR}/voice-server/stop.sh

Test:
\`\`\`bash
curl -X POST http://localhost:8888/notify \\
  -H "Content-Type: application/json" \\
  -d '{"message":"Test message","voice_enabled":true}'
\`\`\`

## Agent Voice IDs (ElevenLabs)

| Agent | Description |
|-------|-------------|
| PAI (Main) | UK Male - Professional |
| Researcher | US Female - Analytical |
| Engineer | US Female - Steady |
| Architect | UK Female - Strategic |
| Designer | Indian Female - Creative |
| Pentester | UK Male - Technical |

See \${PAI_DIR}/voice-server/README.md for complete voice list and IDs.

## Important

The voice-server directory is the canonical source for all voice system documentation.
Always refer to and update voice-server documentation directly.
`,
};
