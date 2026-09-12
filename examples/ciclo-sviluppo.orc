// Ciclo di sviluppo — spec, implement, test, retry with a bounded loop.
// Demonstrates: the agent/assignable ownership split (guide section 2)
// and 'limit' as the structural termination mechanism for loops (guide
// section 5), used instead of a hand-rolled attempt counter.

machine CicloSviluppo {

    locations {
        agent spec: Text;
        agent testsFailedRaw: Nat[0..50];
        testsFailed: Nat[0..50] = 0;
    }

    initial state Spec {
        writes spec;
        prompt: "Write a short specification for the requested feature. Store it in " <spec> ".";
        otherwise -> Implement;
    }

    state Implement {
        prompt: "Implement the feature described in " <spec> ", addressing any prior test failures reported in " <testsFailed> ". Then run the full test suite.";
        limit visits <= 3 else -> Escalate;
        otherwise -> Test;
    }

    state Test {
        writes testsFailedRaw;
        prompt: "Report the number of failing tests from the run you just performed in " <testsFailedRaw> ".";
        set testsFailed = testsFailedRaw;
        on testsFailed == 0 -> Done;
        otherwise -> Implement;
    }

    final state Done {}
    final state Escalate {}
}
