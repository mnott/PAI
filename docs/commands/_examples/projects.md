```bash
# Jump into a project directory (with the shell wrapper installed)
pai cd pai

# Register the current directory as a project
pai projects add .

# Show everything known about a project
pai projects info pai

# Repair a project whose folder moved on disk
pai projects rebind pai /new/path/to/pai

# Audit all registered projects for dead / moved paths
pai projects health --fix
```
