// Moderazione — a record-typed counter updated through a single-field
// 'set', and a bounded re-classification loop.
// Demonstrates: record types and field-path assignment (guide section 3)
// and 'limit' resolving a loop that a guard alone could not bound as
// cleanly (guide section 5).

machine Moderazione {

    locations {
        agent verdict: { allow, review, block };
        stats: record { reviewRounds: Nat[0..5] };
    }

    initial state Classify {
        writes verdict;
        prompt: "Classify the submitted content against the platform policy as allow, review, or block. Store the classification in " <verdict> ".";
        on verdict == #allow -> Approved;
        on verdict == #block -> Rejected;
        otherwise -> Reclassify;
    }

    state Reclassify {
        writes verdict;
        prompt: "The content was flagged as borderline. Re-examine it more carefully, focusing on the specific rule it might violate, and re-classify as allow, review, or block. Store the classification in " <verdict> ".";
        set stats.reviewRounds = stats.reviewRounds + 1;
        limit visits <= 2 else -> HumanReview;
        on verdict == #allow -> Approved;
        on verdict == #block -> Rejected;
        otherwise -> Reclassify;
    }

    final state Approved {}
    final state Rejected {}
    final state HumanReview {}
}
