// =====================================================================
// SupportTriage — triage and response for a support ticket.
//
// Exercises the complete grammar: agent vs. assignable locations, records,
// enums, bounded types, invariants, writes, interpolated prompts, set
// assignments, fuel, guards, and fallback.
//
// Every non-final state requires a prompt and otherwise: it calls the LLM and
// always has a traversable exit.
// =====================================================================

machine SupportTriage {

    locations {
        // --- written by the LLM: guards = self-report -----------------
        agent ticket: record { id: Text, body: Text };
        agent category: { billing, bug, howto, spam };
        agent confidence: Nat[0..100];
        agent draft: Text;
        agent approved: Bool;

        // --- written only by assignments: deterministic guards --------
        replies: Nat[0..3] = 0;
        priority: Nat[0..3] = 0;
        sent: Bool = false;
        escalated: Bool = false;
    }

    // A ticket cannot be both resolved and escalated.
    invariant no_double_close: not (sent and escalated);
    // Nothing is sent before at least one draft is written.
    invariant sent_implies_drafted: not sent or replies > 0;

    initial state Intake {
        writes ticket;
        prompt: "Report the next ticket in the queue: ID and text.";
        limit visits <= 3 else -> Discard;
        on ticket.id != "" -> Classify;
        otherwise          -> Intake;
    }

    state Classify {
        writes category, confidence;
        prompt: "Classify the ticket and state your confidence (0-100).\n\n"
                <ticket.body>;
        on category == #spam -> Discard;
        on confidence < 60   -> Escalate;
        otherwise            -> Draft;
    }

    state Draft {
        writes draft;
        prompt: "Write a response to the customer.\n"
                "Category: " <category>     "\n"
                "Ticket: "   <ticket.body>;
        set replies = replies + 1;
        limit visits <= 3 else -> Escalate;
        on draft != "" -> Check;
        otherwise      -> Escalate;
    }

    // Oracle state: the prompt produces one Boolean judgement.
    state Check {
        writes approved;
        prompt: "Does the draft actually answer the ticket?\n\n"
                "Ticket: " <ticket.body> "\n\n"
                "Draft: "  <draft>;
        on approved    -> Send;
        on replies < 3 -> Draft;
        otherwise      -> Escalate;
    }

    // No writes: the prompt acts, while set updates the store.
    // No guards: otherwise is the unconditional exit.
    state Send {
        prompt: "Send this response to the customer:\n" <draft>;
        set sent = true;
        otherwise -> Done;
    }

    state Escalate {
        prompt: "Escalate the ticket to a human operator with a context note:\n"
                <ticket.body>;
        set escalated = true;
        set priority = 3;
        otherwise -> Done;
    }

    final state Done {}
    final state Discard {}
}
