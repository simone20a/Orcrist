// Verifica misurata — the build/check loop with the check measured rather
// than reported.
// Demonstrates: 'observed' locations written by an 'observe' clause, a
// per-state 'tools' restriction, and pessimistic defaults (guide sections
// 2 and 2.1).
//
// The difference from the reported version is one word in the guard's
// history: `failures` here is what the test command printed, not what the
// model said it printed. The check state also has no way to edit a file,
// so "fix nothing" is a fact about the turn rather than a request inside
// the prompt.

machine VerificaMisurata {

    locations {
        agent plan: Text;
        agent note: Text;

        // Both start at their worst case. A counter that opens at zero is a
        // store claiming the suite passed before it was ever run.
        observed failures: Nat[0..500] = 500;
        observed builds: Bool = false;
    }

    initial state Plan {
        writes plan;
        tools read_file, list_directory;
        prompt: "Read the failing test and the module it exercises, and write in " <plan> " what you intend to change and why. Change nothing on disk — the next state does that.";
        limit visits <= 2 else -> Abandoned;
        otherwise -> Implement;
    }

    state Implement {
        prompt: "Carry out the change described in " <plan> ". Write only the source; do not run the build and do not run the tests, because the states after this one do both.";
        limit visits <= 5 else -> Abandoned;
        otherwise -> Build;
    }

    state Build {
        tools none;
        prompt: "Say in one line what you changed, so the transcript records it. Run nothing: the build is run for you.";
        // No pattern: the exit code is taken, and for a Bool that means
        // "the command succeeded".
        observe builds from "npm run build";
        on builds -> Test;
        otherwise -> Implement;
    }

    state Test {
        writes note;
        tools run_command, read_file, list_directory;
        prompt: "Run the test suite, read the output, and summarise in " <note> " which tests failed and what the failures have in common. Fix nothing — the implementing state owns the repair.";
        observe failures from "npm test 2>&1 | grep -c '^not ok'" else 500;
        on failures == 0 -> Done;
        otherwise -> Implement;
    }

    final state Done {}
    final state Abandoned {}
}
