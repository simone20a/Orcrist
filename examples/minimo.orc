// Minimo — the smallest valid Orcrist model.
// One active state (prompt + otherwise are mandatory), one final state.
// See ../metamodel/authoring-guide.md, section 10.
//
// Note on prompt syntax: an interpolation <location> must sit OUTSIDE the
// surrounding string literals — the grammar tokenizes a prompt into
// alternating STRING and '<' LocationRef '>' parts, so text and
// interpolations are written as separate, juxtaposed pieces.

machine Minimo {

    locations {
        agent ack: Bool;
    }

    initial state Ask {
        writes ack;
        prompt: "Say hello, then confirm you are ready by setting " <ack> " to true.";
        on ack == true -> Done;
        otherwise -> Done;
    }

    final state Done {}
}
