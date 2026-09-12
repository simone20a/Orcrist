machine BugFix {

    locations {
        agent reproducedRaw: Bool;
        agent diagnosis: Text;
        reproduced: Bool = false;
        agent failuresRaw: Nat[0..99];
        failures: Nat[0..99] = 99;
    }

    initial state Reproduce {
        writes reproducedRaw;
        prompt: "Follow the steps in the report and try to make the bug happen. Record whether it reproduced in " <reproducedRaw> ". Do not look for the cause and do not change anything.";
        set reproduced = reproducedRaw;
        on reproduced == true -> Diagnose;
        otherwise -> NotReproducible;
    }

    state Diagnose {
        writes diagnosis;
        prompt: "Find what causes the behaviour you just reproduced and write the cause in " <diagnosis> ". Read code, add logging if you must, but do not fix it yet.";
        otherwise -> Fix;
    }

    state Fix {
        prompt: "Apply the smallest change that addresses the cause recorded in " <diagnosis> ", accounting for the " <failures> " tests that failed last round if there were any. Write code only: run nothing.";
        limit visits <= 3 else -> Escalate;
        otherwise -> Test;
    }

    state Test {
        writes failuresRaw;
        prompt: "Run the full test suite and report the number of failing tests in " <failuresRaw> ". Fix nothing.";
        set failures = failuresRaw;
        on failures == 0 -> Fixed;
        otherwise -> Fix;
    }

    final state Fixed {}
    final state NotReproducible {}
    final state Escalate {}
}
