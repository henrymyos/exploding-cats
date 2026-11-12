DROP YOUR 5 CAT PHOTOS HERE
===========================

Name each file exactly after the cat `id` used in the game, as a WebP (`cwebp -q 82 in.png -o out.webp`):

    cat1.webp
    cat2.webp
    cat3.webp
    cat4.webp
    cat5.webp

(Square images, roughly 400x400 or larger, look best — they get cropped to fill the card.)

To use your cats' real names instead of "Cat One" etc., edit:

    server/cards.js   ->  the CATS array

Change the `name` field for each cat. Keep the `id` matching the photo filename
(e.g. id: 'luna' means the photo should be luna.webp, and you'd reference 'luna'
nowhere else — just keep id and filename in sync).

Until you add photos, the cards show a 🐈 emoji as a placeholder, so the game is
fully playable right now.

THE FERAL CAT (Party Pack wild card)
====================================
The Feral Cat is backed by photos of Stella the dog (stella.webp, stella2.webp …),
listed in STELLA_PHOTOS in public/client.js. To add/replace them, drop square
500x500 WebP images here named stella*.webp and update that list.
