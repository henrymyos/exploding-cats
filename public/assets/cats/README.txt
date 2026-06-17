DROP YOUR 5 CAT PHOTOS HERE
===========================

Name each file exactly after the cat `id` used in the game, as a PNG:

    cat1.png
    cat2.png
    cat3.png
    cat4.png
    cat5.png

(Square images, roughly 400x400 or larger, look best — they get cropped to fill the card.)

To use your cats' real names instead of "Cat One" etc., edit:

    server/cards.js   ->  the CATS array

Change the `name` field for each cat. Keep the `id` matching the photo filename
(e.g. id: 'luna' means the photo should be luna.png, and you'd reference 'luna'
nowhere else — just keep id and filename in sync).

Until you add photos, the cards show a 🐈 emoji as a placeholder, so the game is
fully playable right now.
