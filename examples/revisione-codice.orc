// =====================================================================
// CodeReview — patch review with a limited revision loop.
//
// Demonstrates the oracle pattern: Judge produces one decision from which the
// machine branches. Every graph cycle (Read, Analyze, Revise) has a limit, so
// the machine terminates regardless of the model's behaviour.
// =====================================================================

machine CodeReview {

    locations {
        agent patch: Text;
        agent findings: record {
            blocking: Nat[0..20],
            minor: Nat[0..50],
            summary: Text
        };
        agent verdict: { approve, request_changes, reject };
        agent rationale: Text;

        rounds: Nat[0..4] = 0;
        merged: Bool = false;
        closed: Bool = false;
    }

    invariant outcome_exclusive: not (merged and closed);
    invariant no_blind_merge: not merged or rounds > 0;

    initial state Read {
        writes patch;
        prompt: "Report the contents of the patch to review.";
        limit visits <= 2 else -> Close;
        on patch != "" -> Analyze;
        otherwise      -> Read;
    }

    state Analyze {
        writes findings;
        prompt: "Analyze the patch and count blocking and minor issues.\n\n"
                <patch>;
        set rounds = rounds + 1;
        limit visits <= 4 else -> Close;
        otherwise -> Judge;
    }

    // Oracle state: produces only the verdict and its rationale.
    state Judge {
        writes verdict, rationale;
        prompt: "Give a verdict on the patch.\n"
                "Blocking: " <findings.blocking> "   Minor: " <findings.minor> "\n"
                "Summary: "   <findings.summary>;
        on verdict == #approve and findings.blocking == 0 -> Merge;
        on verdict == #reject                             -> Close;
        on rounds < 4                                     -> Revise;
        otherwise                                         -> Close;
    }

    state Revise {
        writes patch;
        prompt: "Fix the reported issues.\n" <rationale>;
        limit visits <= 3 else -> Close;
        otherwise -> Analyze;
    }

    state Merge {
        prompt: "Merge the patch and announce the merge.";
        set merged = true;
        otherwise -> Done;
    }

    state Close {
        prompt: "Close the review and explain the decision:\n" <rationale>;
        set closed = true;
        otherwise -> Done;
    }

    final state Done {}
}
