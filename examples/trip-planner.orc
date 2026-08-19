// =====================================================================
// TripPlanner — trip quote within a budget.
//
// Exercises arithmetic in guards: the decision to book is not the model's
// judgement, but a comparison calculated from the numbers it reported. This
// is the strongest case possible in a language without tools: the LLM supplies
// data and the runtime performs the calculation.
// =====================================================================

machine TripPlanner {

    locations {
        agent request: record {
            city: Text,
            nights: Nat[1..14],
            travellers: Nat[1..6]
        };
        agent quote: record {
            flight: Nat[0..5000],
            hotel_per_night: Nat[0..800]
        };
        agent choice: { book, cheaper, cancel };

        budget: Nat[0..10000] = 3000;
        searches: Nat[0..5] = 0;
        booked: Bool = false;
    }

    invariant positive_budget: budget > 0;
    invariant no_blind_booking: not booked or searches > 0;

    initial state Brief {
        writes request;
        prompt: "Collect the destination city, number of nights, and travellers.";
        limit visits <= 3 else -> Abort;
        on request.nights > 0 -> Search;
        otherwise             -> Brief;
    }

    state Search {
        writes quote;
        prompt: "Search for a flight and hotel for " <request.city>
                ", " <request.nights> " nights, " <request.travellers> " travellers.";
        set searches = searches + 1;
        limit visits <= 5 else -> Abort;
        on quote.flight + quote.hotel_per_night * request.nights <= budget -> Confirm;
        otherwise -> Negotiate;
    }

    state Negotiate {
        writes choice;
        prompt: "The quote exceeds the budget of " <budget>
                ". Should I look for cheaper alternatives, book anyway, or cancel?";
        on choice == #cheaper and searches < 5 -> Search;
        on choice == #book                     -> Confirm;
        otherwise                              -> Abort;
    }

    state Confirm {
        prompt: "Confirm the booking for " <request.city> ".";
        set booked = true;
        otherwise -> Done;
    }

    state Abort {
        prompt: "Tell the user that the trip cannot be booked within the budget.";
        otherwise -> Done;
    }

    final state Done {}
}
