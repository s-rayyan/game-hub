import { games } from "./games.mjs";

export function initInputHandler() {
    $("#search").on("input", function () {
        const query = $(this).val().toLowerCase();

        $("#game-links .game-link").each(function (i, el) {
            const gameName = games[i].name.toLowerCase();
            if (!gameName.includes(query)) {
                $(el).fadeOut().css("order", 4);
            } else {
                $(el).css("order", 2).fadeIn();
            }
        });
    });
}
