# PAI Configuration Templates

This directory contains example configuration files for personalizing your PAI Knowledge OS setup.

## Files

### `agent-prefs.example.md`

**Template for**: `~/.config/pai/agent-prefs.md`

Contains your personal preferences for PAI agents:
- Identity and role information
- Directory search restrictions
- Project-code directory mappings
- Notification preferences (WhatsApp, ntfy.sh)
- Voice configuration for TTS
- Git commit rules
- Code quality standards
- Language and framework preferences
- Workflow customization options

**Size**: 362 lines, comprehensive with examples

**Setup**:
```bash
cp agent-prefs.example.md ~/.config/pai/agent-prefs.md
# Then customize with your settings
```

### `voices.example.json`

**Template for**: `~/.config/pai/voices.json`

Configures voice output for different agents and channels:
- TTS system selection (Kokoro local or ElevenLabs cloud)
- Voice assignments per agent type
- WhatsApp voice note configuration
- Local speaker output settings
- Named personas for easy reference
- Multiple profiles (professional, casual, focus)
- Complete examples for different setups
- Troubleshooting guide

**Size**: 251 lines, valid JSON with comments

**Setup**:
```bash
cp voices.example.json ~/.config/pai/voices.json
# Then customize voice selections
```

## Quick Start

```bash
# Create config directory if needed
mkdir -p ~/.config/pai

# Copy templates
cp agent-prefs.example.md ~/.config/pai/agent-prefs.md
cp voices.example.json ~/.config/pai/voices.json

# Edit with your preferences
nano ~/.config/pai/agent-prefs.md
nano ~/.config/pai/voices.json
```

## Key Features

### Agent Preferences

- **Directory Restrictions**: Prevent expensive searches in large directories
- **Project Mappings**: Automate end-session commits to the right directories
- **Workflow Customization**: Tailor agent behavior to your development style
- **Voice and Notifications**: Configure how agents communicate with you

### Voice Configuration

- **Kokoro TTS**: Free, local, no API key required (~160MB download once)
- **ElevenLabs**: Premium quality voices, requires API key
- **Agent-Specific Voices**: Different voices for different agent types
- **Profiles**: Switch between professional/casual/focus modes

## Privacy and Version Control

These files contain personal preferences and should **NOT** be committed:

```bash
# Add to your .gitignore
echo "~/.config/pai/" >> ~/.gitignore
```

Keep these files private:
```bash
chmod 600 ~/.config/pai/agent-prefs.md
chmod 600 ~/.config/pai/voices.json
```

## Integration with PAI

The PAI daemon automatically:
- Reads `~/.config/pai/agent-prefs.md` on startup
- Loads voice configuration from `~/.config/pai/voices.json`
- Uses these settings for all agent operations
- Falls back to sensible defaults if files are missing

**No restart needed**: Changes to these files take effect immediately on next operation.

## Customization Examples

### Minimal Setup (Just Defaults)

```bash
# Copy templates
cp agent-prefs.example.md ~/.config/pai/agent-prefs.md
cp voices.example.json ~/.config/pai/voices.json

# Use defaults as-is, customize later as needed
```

### Engineer-Heavy Workflow

Focus on technical tools and code quality:
- Set default language to TypeScript
- Configure strict testing requirements
- Map multiple code directories
- Use technical-sounding voices

### Research-Heavy Workflow

Focus on information gathering:
- Configure ntfy.sh notifications for task completion
- Set longer timeouts for research agents
- Map knowledge base directories
- Use calm, analytical voices

## Environment Variables

Some settings can also be configured via environment variables:

```bash
export ELEVENLABS_API_KEY="sk-..."        # ElevenLabs API key
export NTFY_TOPIC="my-private-topic"      # ntfy.sh topic
export PAI_CONFIG_DIR="~/.config/pai"     # Custom config directory
```

## Troubleshooting

**Q: My preferences aren't being used**
- Check file exists: `ls ~/.config/pai/agent-prefs.md`
- Check JSON is valid: `python3 -m json.tool ~/.config/pai/voices.json`
- Check permissions: `ls -l ~/.config/pai/`

**Q: Voice not working**
- Verify ElevenLabs API key if using ElevenLabs
- Check internet connection if using cloud TTS
- Try local Kokoro TTS as fallback
- See troubleshooting section in `voices.example.json`

**Q: Configuration not loading**
- Daemon reads from `~/.config/pai/` (not `~/.claude/`)
- Create directory if missing: `mkdir -p ~/.config/pai`
- Copy templates to this location

## Further Customization

Once you've customized the basic templates, you can:

1. **Create project-specific overrides** in project `.claude.json` files
2. **Add team standards** to agent-prefs.md under "Team Standards"
3. **Define CI/CD rules** in git commit section
4. **Experiment with voice profiles** for different working modes

## Related Documentation

- PAI Knowledge OS: `~/projects/PAI/README.md`
- Configuration reference: `~/.claude.json` (Claude Code configuration)
- PAI daemon docs: `~/projects/PAI/src/daemon/`

---

**Template Version**: 1.0
