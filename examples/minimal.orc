// =====================================================================
// Minimal — the smallest valid model possible.
//
// Shows what is truly required: the locations block and invariants may be
// omitted, but every non-final state must have a prompt and otherwise branch.
// =====================================================================

machine Minimal {

    initial state Ask {
        prompt: "Greet the user and ask how you can help.";
        otherwise -> Done;
    }

    final state Done {}
}
