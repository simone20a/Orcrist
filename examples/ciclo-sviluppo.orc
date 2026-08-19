// =====================================================================
// DevLoop — specification, implementation, testing, and triage.
//
// The language's original use case. It demonstrates the ownership boundary:
// without a channel to the external world, test results are an LLM
// self-report (agent tests), so the tests.failed == 0 guard is only as
// reliable as the model. Counters are the only deterministic values.
// =====================================================================

machine DevLoop {

    locations {
        agent spec: Text;
        agent decision: { retry, refine, escalate };
        agent tests: record { total: Nat, passed: Nat, failed: Nat };

        attempts: Nat[0..10] = 0;
    }

    invariant consistency: tests.passed + tests.failed <= tests.total;

    initial state Plan {
        writes spec;
        prompt: "Read the requirement and produce an executable specification.";
        limit visits <= 3 else -> Escalate;
        on spec != "" -> Implement;
        otherwise     -> Plan;
    }

    state Implement {
        writes spec;
        prompt: "Implement " <spec> ". Current failures: " <tests.failed>;
        set attempts = attempts + 1;
        limit visits <= 5 else -> Escalate;
        otherwise -> RunTests;
    }

    state RunTests {
        writes tests;
        prompt: "Run the test suite for " <spec> " and report total/passed/failed.";
        on tests.failed == 0              -> Done;
        on tests.passed * 2 > tests.total -> Triage;
        otherwise                         -> Implement;
    }

    state Triage {
        writes decision;
        prompt: "Review the failures. Decide how to proceed.";
        on decision == #retry and attempts < 5 -> Implement;
        on decision == #refine                 -> Plan;
        otherwise                              -> Escalate;
    }

    state Escalate {
        prompt: "Escalate the problem to a human developer with the context.";
        otherwise -> Done;
    }

    final state Done {}
}
