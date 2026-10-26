# Evaluation: how often the memory is wrong

Each case is a short conversation, the memory before it, and a draft a model could write. Each draft item is labelled by
someone who never saw the checking rules: **trust** (the user's words really back it) or **hold** (it should wait for the
user). `run.js` applies the real core and counts two errors that matter to a user:

- **false trust**: saved as the user's, or applied, though it should have waited. This is the one that breaks trust.
- **false hold**: correct, but held for review. Its cost is an extra click.

```
node tests/eval/run.js --dev      # development set 1 (100 cases)   — rules may be tuned on it
node tests/eval/run.js --dev2     # development set 2 (80 cases)    — rules may be tuned on it
node tests/eval/run.js            # held-out set 1 (80 cases)
node tests/eval/run.js --v2       # held-out set 2 (80 cases)
```

## The rule

The rules are tuned on the development sets only. A held-out set is measured once, for a release, and is then no
longer blind. The next release writes a new held-out set before tuning starts.

| Set | Status |
|---|---|
| `dev.json`, `dev2.json` | development: tune freely |
| `cases.json` (held-out 1) | measured for 1.5, and once for 2.0 in progress (its results led to `dev2.json`) |
| `cases2.json` (held-out 2) | written for 2.0 by an author who never saw the rules; measured once, for 2.0 |

## Results (`results-2.0.json`)

| Set | 1.5 false trust | 2.0 false trust | 1.5 false hold | 2.0 false hold |
|---|---|---|---|---|
| development 1 | 16/77 (20.8%) | 6/77 (7.8%) | 58/101 (57.4%) | 14/101 (13.9%) |
| development 2 | 29/55 (52.7%) | 3/55 (5.5%) | 20/38 (52.6%) | 5/38 (13.2%) |
| **held-out 1** | 6/68 (8.8%) | 11/68 (16.2%) | 22/72 (30.6%) | 11/72 (15.3%) |
| **held-out 2** | 22/68 (32.4%) | 19/68 (27.9%) | 25/73 (34.2%) | 15/73 (20.5%) |

**What the held-out sets say about 2.0:**
- **False holds:** about half as many (both sets).
- **False trust:** not clearly better.
  - It is worse on the first set and better on the second.
  - Over both sets together it is about the same: 30/136 (22.1%) against 28/136 (20.6%).

So the gains on the development sets are largely the rules learning those sets. The checks are guards that catch
some contradictions; they do not guarantee the meaning, which is why nothing becomes «✓ confirmed» except by the
user's approval.

**Known weak spots (held-out 2):**
- removing a constraint without a real reason (0/4 caught, as in 1.5);
- constraints the user never set as standing rules (4/9);
- partial or conditional approvals (8/12);
- swapped details (7/10).

The next development set should target these.
