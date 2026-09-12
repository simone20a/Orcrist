# A demanding task for the agent

Everything between the rules below is the prompt: paste it into a new session as
it stands. It is written the way someone who wanted this store would write it —
it describes the thing and what has to be true of it, and says nothing about
machines, states or phases. Whether the process is worth structuring is the
app's judgement to make from the work, not something the prompt should be
whispering.

---

Build me a crash-safe embedded key–value store, as a single Python package
`kvstore/` in this workspace. Python 3.11+, standard library only — no
third-party imports anywhere, tests and tools included.

**The store.** `KV(path)` opens or creates a store rooted at `path`. It offers
`put(key, value)`, `put_many(items)`, `get(key)`, `delete(key)`, `keys()` and
`close()`, and works as a context manager. Keys are `str`, values are `bytes`.
Data lives in a write-ahead log plus a compacted data file; the log is replayed
on open. When the log passes 1 MB it is folded into the data file and truncated,
and that compaction must itself be safe to interrupt at any point.

**Durability is the whole point, so be precise about it.** `put`, `put_many` and
`delete` return only after the change has been flushed. A crash may land at any
instant: mid-record, mid-compaction, between a flush and the rename that follows
it. After any crash, reopening must yield exactly the key/value pairs of the last
acknowledged operation — never a half-written record, never a lost acknowledged
write, never a resurrected deleted key. Note that `fsync` on macOS does not flush
the drive's own write cache and `F_FULLFSYNC` does; decide which one this store
uses, and say why in the README rather than leaving it implicit.

**Check it with something independent, not with your own opinion of it.** Write
`tools/crashtest.py`, a separate program that does **not** import the store's
internals. It drives a
child process through a scripted workload, kills it with `SIGKILL` at a randomly
chosen write boundary, reopens the store in a fresh process and compares what it
finds against its own in-memory model of what should be there. It takes
`--trials` and `--seed`, prints the seed for every mismatch so a failure can be
replayed exactly, and finishes by printing the number of mismatches on its own
line. Be honest in the README about what this proves: killing a process does not
evict the operating system's page cache, so these trials establish
application-level atomicity, not power-loss durability.

**What I will check when you say it is done.**

1. The unit suite passes, with at least 25 tests, covering: reopen after clean
   close, overwrite, delete then reopen, an empty value, a 1 MB value, keys
   containing newlines and null bytes, replay of a log truncated mid-record, and
   a store opened on a directory that does not exist yet.
2. `python tools/crashtest.py --trials 200` reports **0 mismatches**.
3. `python tools/bench.py` prints two numbers it measured: sequential
   `put_many` throughput in batches of 1000 with 100-byte values, which must be
   at least 20,000 puts/second, and the single durable `put` rate, which is
   reported but not required to hit any threshold — it is bounded by how fast
   the disk can flush, and a store that beats physics is a store that is not
   flushing.
4. `README.md` documents the on-disk format precisely enough that someone could
   write a reader from the README alone, and states plainly which failure modes
   are covered and which are not.

Don't tell me it works — run these and give me the numbers they printed. And if
the crash trials keep failing, stop patching the replay path and go back to the
on-disk format: a format that cannot be made safe and a bug in code that already
accounts for the format are different problems, and only one of them is fixed by
editing the replay path.

---

## What a good run should produce

This is not part of the prompt and is not given to the agent — it is what to
compare the authored machine against. The task above never mentions states, so
anything of this shape is the app inferring the process from the work. The
machine below parses and passes the validator: 9 states, 15 edges, no warnings.

```orcrist
machine CrashSafeStore {

    locations {
        agent format: Text;
        agent unitFailuresRaw: Nat[0..200];
        agent mismatchesRaw: Nat[0..500];
        agent throughputRaw: Nat[0..1000000];

        unitFailures: Nat[0..200] = 0;
        mismatches: Nat[0..500] = 0;
        throughput: Nat[0..1000000] = 0;
    }

    invariant durableOrNothing: mismatches <= 500;

    initial state Design {
        writes format;
        prompt: "Design the on-disk format for the store: record framing, the log, the data file, and how compaction swaps them over without a window in which a crash loses data. Write it to docs/format.md and summarise it in " <format> ". Do not write any implementation code.";
        limit visits <= 3 else -> Abandoned;
        otherwise -> Implement;
    }

    state Implement {
        prompt: "Implement kvstore/ against the format recorded in " <format> ". Fix the " <unitFailures> " failing unit tests and the " <mismatches> " crash mismatches from the previous round if there were any. Write code only: do not run the test suite, the crash trials or the benchmark.";
        limit visits <= 6 else -> Abandoned;
        otherwise -> UnitTest;
    }

    state UnitTest {
        writes unitFailuresRaw;
        prompt: "Run the unit suite and report the number of failing tests in " <unitFailuresRaw> ". Do not fix anything and do not run the crash trials.";
        set unitFailures = unitFailuresRaw;
        on unitFailures == 0 -> CrashTest;
        otherwise -> Implement;
    }

    state CrashTest {
        writes mismatchesRaw;
        prompt: "Run 'python tools/crashtest.py --trials 200' and report the number of mismatches it printed in " <mismatchesRaw> ". Report what the tool printed, not what you expect it to print.";
        set mismatches = mismatchesRaw;
        limit visits <= 4 else -> Abandoned;
        on mismatches == 0 -> Benchmark;
        otherwise -> Diagnose;
    }

    state Diagnose {
        writes format;
        prompt: "The crash trials failed " <mismatches> " times. Replay a failing seed and decide which this is: a bug in code that the format already accounts for, or a format that cannot be made safe. If it is the format, revise docs/format.md and record the revision in " <format> "; if it is a bug, leave the format as it stands. Change no implementation code here.";
        limit visits <= 4 else -> Abandoned;
        otherwise -> Implement;
    }

    state Benchmark {
        writes throughputRaw;
        prompt: "Run 'python tools/bench.py' and report the batched puts/second it printed in " <throughputRaw> ".";
        set throughput = throughputRaw;
        limit visits <= 3 else -> Abandoned;
        on throughput >= 20000 -> Document;
        otherwise -> Implement;
    }

    state Document {
        prompt: "Write README.md: the on-disk format in enough detail to write a reader from it, the flushing decision and its reasoning, and an honest list of the failure modes covered and not covered. Do not change any code.";
        otherwise -> Shipped;
    }

    final state Shipped {}
    final state Abandoned {}
}
```

Two things to look for in whatever the app actually authors.

**The failure loops are at different depths.** A unit failure goes straight back
to `Implement` — it is a bug, and the design still stands. A crash mismatch goes
to `Diagnose` first, which is allowed to rewrite the format and nothing else.
Those are different responses to different kinds of wrong, and a to-do list
cannot express the difference.

They are not, however, two loops. `Implement`, `UnitTest`, `CrashTest`,
`Diagnose` and `Benchmark` are mutually reachable, so the validator sees them as
one strongly-connected component — strip every `limit` from the machine and the
diagnostic names exactly that: *the loop Implement -> UnitTest -> CrashTest ->
Benchmark -> Diagnose -> Implement has no 'limit visits <= N else -> …' on any of
its states*. One `limit` anywhere in that component satisfies the rule. The five
written here are a design decision rather than a requirement: they bound each
phase on its own terms, so a run that is stuck redesigning the format gives up
after three attempts at that rather than after six attempts at something else.

**Every guard reads a number a program printed.** `unitFailures`,
`mismatches` and `throughput` are agent-owned on the way in and assignable on the
way out: the model reports what it saw, the runtime decides what it means. A run
where the model reports `mismatches = 0` because it would like to move on is a
run that ships a broken store — which is why the prompts say to report what the
tool printed, and why the crash tool is forbidden from importing the code it is
judging.
