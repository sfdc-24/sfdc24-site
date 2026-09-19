# VANLAS remaining for PR 81

Copy from box `/workspace/sfdc24-fix-work/` then:

```
git checkout grok-bot/overnight-polish-check-footers
# overwrite with box copies:
# index.html, assets/chrome.js, assets/triage.js, assets/triage.py
# method/panels/projects/intake/looks/org/review/agents index.html
# data/agent-reply-metrics.jsonl
git add -A && git commit -m "Overnight polish: full index + chrome + page footers + triage"
git push origin HEAD
```

Script: `/workspace/push-polish/VANLAS-push-pr81.ps1`
