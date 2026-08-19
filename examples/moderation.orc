// =====================================================================
// Moderation — content moderation with persistent counters.
//
// The only example with a record not marked agent. It shows how to maintain a
// structured counter and assign one field (set tally.removed = ...).
// Assignable records have no initializer because Expr has no record literals.
// Initialize their fields manually in the initial state before a guard or
// invariant reads them.
// =====================================================================

machine Moderation {

    locations {
        agent item: record { id: Text, body: Text };
        agent label: { safe, spam, harassment, unclear };
        agent severity: Nat[0..5];
        agent worth_removing: Bool;

        tally: record { reviewed: Nat[0..99], removed: Nat[0..99] };
        strikes: Nat[0..3] = 0;
        takedown: Bool = false;
    }

    invariant tally_sane: tally.removed <= tally.reviewed;
    invariant strike_on_takedown: not takedown or strikes > 0;

    initial state Boot {
        writes item;
        prompt: "Report the next content to moderate: ID and text.";
        set tally.reviewed = 0;
        set tally.removed = 0;
        limit visits <= 2 else -> Done;
        on item.id != "" -> Classify;
        otherwise        -> Boot;
    }

    state Classify {
        writes label, severity;
        prompt: "Label the content and assign a severity from 0 to 5.\n\n"
                <item.body>;
        set tally.reviewed = tally.reviewed + 1;
        on label == #unclear -> Escalate;
        on label == #safe    -> Keep;
        on severity >= 3     -> Remove;
        otherwise            -> Keep;
    }

    // Oracle state for uncertain cases: one Boolean judgement.
    state Escalate {
        writes worth_removing;
        prompt: "This is an uncertain case. Should this content be removed?\n\n"
                <item.body>;
        on worth_removing -> Remove;
        otherwise         -> Keep;
    }

    state Remove {
        prompt: "Remove the content and notify the author, citing the label "
                <label> ".";
        set takedown = true;
        set strikes = strikes + 1;
        set tally.removed = tally.removed + 1;
        otherwise -> Done;
    }

    state Keep {
        prompt: "Keep the content online and archive the decision.";
        otherwise -> Done;
    }

    final state Done {}
}
