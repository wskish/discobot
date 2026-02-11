#!/bin/bash
# Validate all skills using the official skills-ref validator

set -e

SKILLS=(
  ".claude/commands/release"
  ".claude/commands/commit"
  ".claude/skills/web-design-guidelines"
  ".claude/skills/vercel-react-best-practices"
)

echo "Validating skills..."
echo

for skill in "${SKILLS[@]}"; do
  uvx --from 'git+https://github.com/agentskills/agentskills.git#subdirectory=skills-ref' skills-ref validate "$skill"
done

echo
echo "✓ All ${#SKILLS[@]} skills are valid"
