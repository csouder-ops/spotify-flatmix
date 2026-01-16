# spotify-flatmix

Flat Mix – group Spotify recommender

## Company-impact tracker (prototype)

This repo now includes a small, local-only tracker to log public statements or actions that may affect specific companies. It is designed for research and record-keeping and **is not investment advice**. Always verify sources and consult a qualified professional before making financial decisions.

### Requirements

* Python 3.10+

### Usage

Create or update the local SQLite database and add an event:

```bash
python tracker.py add \
  --date 2024-11-01 \
  --source "Truth Social" \
  --subject "Donald Trump" \
  --company "Example Corp" \
  --summary "Posted about tariffs impacting supply chain." \
  --url "https://example.com/source" \
  --sentiment neutral \
  --tags "tariffs,trade"
```

List all events:

```bash
python tracker.py list
```

Filter by company:

```bash
python tracker.py list --company "Example Corp"
```

### Data integrity tips

* Store primary sources (links or archived copies).
* Use consistent company names to make filtering easier.
* Keep summaries short and factual.
