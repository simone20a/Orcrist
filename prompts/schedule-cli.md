# A demanding task for the agent — a command-line tool

Everything between the rules below is the prompt: paste it into a new session as
it stands. It is written the way someone who wanted this tool would write it —
it describes the tool and what has to be true of it, and says nothing about
machines, states or phases. Whether the process is worth structuring is the
app's judgement to make from the work, not something the prompt should be
whispering.

---

Build me a command-line tool called `sched` for working out when recurring
schedules actually fire. One Python package in this workspace, `sched/`, runnable
as `python -m sched`. Python 3.11+, standard library only — no third-party
imports anywhere, tests included.

**The expression language.** The five cron fields — minute, hour, day-of-month,
month, day-of-week — with `*`, single values, lists (`1,15,30`), ranges (`9-17`),
steps (`*/5`, `10-40/3`), three-letter names (`JAN`, `MON`, case-insensitive),
and the `@yearly @monthly @weekly @daily @hourly` macros. Plus three extensions:
`L` in day-of-month for the last day of the month, `L` in day-of-week for the
last of that weekday in the month, and `#` for the nth (`FRI#3` is the third
Friday). Keep the usual cron rule that when day-of-month and day-of-week are both
restricted the two are ORed rather than ANDed, and spell that out in the README,
because everyone gets it wrong.

**The subcommands.**

- `sched next <expr> [-n N] [--from ISO8601] [--tz ZONE] [--utc] [--json]`
- `sched prev <expr> [-n N] [--from ISO8601] [--tz ZONE] [--utc] [--json]`
- `sched between <expr> <start> <end> [--tz ZONE] [--count] [--json]`
- `sched explain <expr>` — a line or two of plain English: `*/15 9-17 * * MON-FRI`
  is "every 15 minutes, between 09:00 and 17:59, Monday to Friday".
- `sched check <expr>` — exit 0 if it is valid, exit 2 if not, with a message on
  stderr naming the bad field and pointing at the character.
- `sched diff <exprA> <exprB> --from ISO --to ISO [--json]` — whether the two fire
  at exactly the same instants across that window, and the first few differences
  if not.

**The time zone handling is the part I care about most.** Everything is computed
in a named IANA zone (`--tz`, defaulting to the system zone; `--utc` is shorthand
for `--tz UTC`). Two situations have no obviously right answer, so pick an
answer, write down why in the README, and test both:

- The local time does not exist because the clock jumped forward over it. A daily
  `30 2 * * *` on the morning the clock goes 02:00 → 03:00 has no 02:30 to fire
  at.
- The local time happens twice because the clock went back. That same `30 2 * * *`
  has two 02:30s on the autumn transition.

Whichever way you go, the output must be strictly increasing in real time and
must never repeat an instant. Be careful here: `zoneinfo` will not catch this for
you, because building a local time that does not exist does not raise — it
quietly resolves to the offset that was in force before the transition. In
`Pacific/Apia`, which skipped 30 December 2011 altogether when it crossed the
date line, noon on the 30th and noon on the 31st both come out as
2011-12-30T22:00Z. The same instant, from two different local days. Anything that
works in local time and converts at the end will emit it twice and never notice.
Timestamps print as ISO 8601 with an explicit offset.

**Check it against a reference implementation, not against your own opinion.**
Write `tests/reference.py`: a deliberately stupid matcher that walks a window
minute by minute in the target zone and keeps every minute whose fields all
match. It can be hundreds of times slower than the real thing — it exists to be
obviously correct, so write it for clarity and leave it unoptimised. Then
`tests/test_differential.py` generates at least 500 random expressions and
compares `sched` against that reference over random windows in at least six
zones. Use `Europe/Rome`, `America/Santiago` (southern-hemisphere DST),
`Australia/Lord_Howe` (a 30-minute DST shift, not an hour), `Asia/Kolkata` (half-
hour offset, no DST), `UTC` and `Pacific/Apia`, and make sure some windows
straddle DST transitions, year boundaries and leap days. It has to report how
many expressions mismatched and print a seed that reproduces each one.

**What I will check when you say it is done.**

1. The unit suite passes, and there are at least 40 tests. Among them: each
   extension (`L`, `#`, steps, names, macros), the DOM/DOW OR rule, both DST
   cases, a leap day (`0 12 29 2 *`), `prev`/`next` symmetry, and an expression
   that can never fire (`0 0 30 2 *` — 30 February) which has to be reported as
   impossible rather than hang.
2. `python -m pytest tests/test_differential.py` reports **0 mismatching
   expressions**.
3. `python tools/bench.py` prints the wall-clock milliseconds of the slowest of
   `sched next '0 3 29 2 *' -n 100`, `sched next '0 0 L 2 *' -n 100` and
   `sched next '*/5 * * * *' -n 1000`, and the slowest is **under 50 ms**. That
   number is chosen to rule out an implementation, not to make the tool feel
   snappy: the hundredth leap-year 29 February from now lands in 2436, so
   stepping a minute at a time means walking some 216 million minutes — about
   thirty seconds of Python even with no zone conversion and no matching inside
   the loop. Work out where the next firing is; do not go looking for it.
4. `tools/clicheck.sh` drives the tool the way a user would and reports how many
   checks failed: `--help` at the top level and for every subcommand; a bad
   expression exits 2 with nothing on stdout and a message on stderr; an unknown
   zone exits 2 and names it; every `--json` output parses with
   `python -m json.tool`; no ANSI escapes when stdout is not a TTY or when
   `NO_COLOR` is set; `sched next` with no arguments exits non-zero instead of
   printing a traceback.
5. `README.md` covers the grammar, the DOM/DOW rule, the two DST decisions and
   the reasoning behind them, and the exit codes.

Don't tell me the tests pass — run them and give me the numbers they printed. And
if the differential test keeps failing, stop patching the code and work out
whether the rule you wrote down is the rule you implemented; those are different
problems and only one of them is fixed by editing the matcher.

---

## What a good run should produce

This is not part of the prompt and is not given to the agent — it is what to
compare the authored machine against. The task above never mentions states, so
anything of this shape is the app inferring the process from the work. The
machine below parses and passes the validator: 11 states, 20 edges, no warnings.

```orcrist
machine ScheduleCli {

    locations {
        agent semantics: Text;
        agent unitFailuresRaw: Nat[0..300];
        agent mismatchesRaw: Nat[0..1000];
        agent slowestMsRaw: Nat[0..600000];
        agent cliFaultsRaw: Nat[0..100];

        unitFailures: Nat[0..300] = 0;
        mismatches: Nat[0..1000] = 0;
        slowestMs: Nat[0..600000] = 600000;
        cliFaults: Nat[0..100] = 0;
    }

    initial state Semantics {
        writes semantics;
        prompt: "Decide the semantics before writing any code: the grammar including L and #, the day-of-month / day-of-week OR rule, and what happens to a local time that does not exist and to one that happens twice. Write them to docs/semantics.md and summarise the two DST decisions in " <semantics> ". Write no implementation and no tests.";
        limit visits <= 3 else -> Abandoned;
        otherwise -> Implement;
    }

    state Implement {
        prompt: "Implement sched/ and its tests against the semantics recorded in " <semantics> ", addressing the " <unitFailures> " failing unit tests and " <mismatches> " differential mismatches from the previous round if there were any. Write code only: run nothing.";
        limit visits <= 8 else -> Abandoned;
        otherwise -> UnitTest;
    }

    state UnitTest {
        writes unitFailuresRaw;
        prompt: "Run the unit suite, excluding the differential test, and report the number of failing tests in " <unitFailuresRaw> ". Fix nothing and run nothing else.";
        set unitFailures = unitFailuresRaw;
        on unitFailures == 0 -> Differential;
        otherwise -> Implement;
    }

    state Differential {
        writes mismatchesRaw;
        prompt: "Run the differential test against the reference implementation and report the number of mismatching expressions in " <mismatchesRaw> ". Report the number it printed, not the number you expect.";
        set mismatches = mismatchesRaw;
        limit visits <= 5 else -> Abandoned;
        on mismatches == 0 -> Benchmark;
        otherwise -> Adjudicate;
    }

    state Adjudicate {
        writes semantics;
        prompt: "The differential test found " <mismatches> " mismatching expressions. Replay one failing seed and decide which side is wrong: the implementation, or the rule it was implementing. If the rule, revise docs/semantics.md and record the change in " <semantics> "; if the implementation, leave the semantics as they are. Change no implementation code here.";
        limit visits <= 5 else -> Abandoned;
        otherwise -> Implement;
    }

    state Benchmark {
        writes slowestMsRaw;
        prompt: "Run tools/bench.py and report the slowest of the three timings, in whole milliseconds, in " <slowestMsRaw> ".";
        set slowestMs = slowestMsRaw;
        limit visits <= 4 else -> Abandoned;
        on slowestMs <= 50 -> CliAudit;
        otherwise -> Optimise;
    }

    state Optimise {
        prompt: "The slowest benchmark took " <slowestMs> " ms against a 50 ms floor, so the search is scanning where it should be computing. Rework the date arithmetic to jump to the next candidate instead of stepping through time. Change no semantics and add no features.";
        limit visits <= 3 else -> Abandoned;
        otherwise -> UnitTest;
    }

    state CliAudit {
        writes cliFaultsRaw;
        prompt: "Run tools/clicheck.sh and report the number of failed checks in " <cliFaultsRaw> ". This covers help text, exit codes, stdout and stderr discipline, JSON validity and colour suppression.";
        set cliFaults = cliFaultsRaw;
        limit visits <= 4 else -> Abandoned;
        on cliFaults == 0 -> Document;
        otherwise -> Implement;
    }

    state Document {
        prompt: "Write README.md: the grammar, the day-of-month / day-of-week OR rule, the two DST decisions with the reasoning behind them, the exit codes, and the measured benchmark numbers. Change no code.";
        otherwise -> Shipped;
    }

    final state Shipped {}
    final state Abandoned {}
}
```

Three things to look for in whatever the app actually authors.

**Does `Optimise` come back through the tests?** Rewriting the date arithmetic is
exactly the kind of change that trades correctness for speed without anyone
noticing, so a machine that goes straight back to `Benchmark` after optimising is
missing the point. That one arrow is the process knowledge this task is really
testing, and it is what a to-do list cannot hold: a list says *implement, test,
optimise, ship*, and has no way of saying that step four invalidates step two.

**Is deciding separated from acting?** A mismatch between the implementation and
the reference does not say which of the two is wrong. `Adjudicate` exists to work
that out and is allowed to write the semantics and nothing else.

**Is `slowestMs` pessimistic by default?** It starts at its own maximum rather
than at 0, because the guard is `slowestMs <= 50`: a location starting at zero is
a store claiming the benchmark passed before it has ever run, and if anything
went wrong on the way to `Benchmark` the machine would sail through on a number
nobody measured. A default is a claim about the world, and the safe claim is the
pessimistic one.
