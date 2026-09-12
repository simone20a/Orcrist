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
