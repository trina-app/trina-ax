// Memorable temporary passwords: one easy English word + four digits, e.g. "tiger4271", "maple0385", "piano7712".
//
// Used wherever the system makes a temporary password (admin "add member" and "reset password", the admin form that
// pre-fills one to hand over, the server CLI). A temporary password is one-time: the person must change it at first
// sign-in, it stops working TEMP_PASSWORD_TTL_DAYS days after it was set, and the server voids it after
// TEMP_PASSWORD_MAX_FAILURES wrong tries (server/src/auth/accounts.ts). So it trades length for being easy to read out
// and type at a clinic desk.
//
// Format: a word of 4-7 lower-case letters from TEMP_WORDS, then 4 digits 0-9, so 8-11 characters (passes the
// 8-character rule). The digits always come after the letters, so 0/O and 1/l cannot be mixed up.
//
// Entropy (min-entropy = the chance of the single most likely password): log2(1007 words) + 4 x log2(10) = 23.3 bits,
// about one in ten million. ~30 bits would need two words or seven digits, which is no longer "about 8 characters".
// That is weak against offline cracking (a stolen database: about ten CPU-days against argon2id) and acceptable only
// because guessing is online: argon2id hashes, 10 failed sign-ins / 15 min per account and 30 per real IP (also
// through the Cloudflare tunnel), voided after TEMP_PASSWORD_MAX_FAILURES wrong tries (a guesser wins with at most
// 50 / 10^7 = 0.0005%), valid 7 days, replaced by the person's own password at the first sign-in.
//
// TEMP_WORDS (owner decision 2026-10-21, reviewed for the exampleteam clinic pilot with Korean and Indonesian staff): basic,
// concrete words that are easy to spell when read aloud (food, animals, places, things, colours, months, a few
// cities) - no hard spellings (rhythm, yacht, khaki...), no silent letters (knee, climb, island...), nothing
// unpleasant, violent, medical-worry, religious or slangy (knife, needle, ghost, snake, wine...), and no two words
// that differ by one letter, one added or dropped letter, or two swapped letters (bean/bear, star/start, quiet/quite)
// or that sound the same (peace/piece, medal/metal). Lower-case a-z only, 4-7 letters, no duplicates
// (tests/unit/a-temp-passwords.test.ts checks all of this).

export const TEMP_PASSWORD_TTL_DAYS = 7
/** Wrong sign-in tries that void a temporary password. High enough that a stranger guessing a desk's username cannot
 * easily lock a new member out (the per-account limit makes 50 tries take over an hour), low enough to bound a guesser. */
export const TEMP_PASSWORD_MAX_FAILURES = 50

export const TEMP_WORDS: readonly string[] = `
above action active agree airport alarm album almond alpaca alpha always amazing amber anchor angle animal answer
apple apricot april apron aqua arcade arrive arrow artist athlete atlas attic august aunt author avenue avocado award
awesome baby bacon badge bagel bakery baking balcony ball balloon bamboo banana banjo bank banner barber barley barn
barrel basil basket bathtub battery beach bean beanie beaver bedroom bedtime beehive begin belt bento berlin berry
bicycle bike binder bingo bird black blanket blender bloom blossom blue board boat bonsai bonus book border bottle
bottom bounce bowl bowling boxing branch brave brazil bread breeze brick bright bring bronze brother brownie brush
bubble bucket buddy buffalo build bulgogi bundle burger busan busy butter button cabbage cabin cabinet cable cactus
cafe camel camera camping campus canada canal candle candy canoe canopy canvas canyon captain caramel card careful
cargo carpet carrot cartoon cashew catfish celery center cereal chain chalk channel charm chat cheddar cheer cheese
chef cherry chess chick chicken child chilly chimney choice cinema circle circus citrus city clam classic clean cliff
clock close cloudy clover coach cocoa coconut coffee cold collar color comedy comet comfort comic compass concert
contest cookie cooking cool copper coral corn corner cosmos costume cottage cotton cousin cowboy cozy crab cracker
crane crayon creek cricket crisp crown crystal cupcake curry curtain cushion cute daisy dance dancing darts dawn
daytime deer denim dentist design desk desktop diamond diary dinner disco diving doll dolphin domino donkey donut door
doorway dozen dragon drama draw drawer drawing dream dress drink drive drum drummer dubai duck duet durian eagle early
earth easel easy edge eighty elbow eleven email emerald emoji empty energy engine enjoy eraser evening exam extra
fairy falcon family famous fantasy farmer fast father fence fern field fiesta fifty figure film final firefly first
fish fishing five flag flame flash flight float floor florist flower fluffy flute focus foggy folder forest fork
fortune forty fossil four freezer fresh friday fridge friend fries frog frost fruit fudge future fuzzy gadget galaxy
gallery game garage garden garlic gecko gelato gentle giant gift giggle ginger giraffe glacier glad glass glider
glitter glove goal golden golf golfer good goose gorilla grand grandma granola grape gravity gray great green grill
grocery group grow guide guitar gummy haircut hammer hammock hamster handbag hanger happy harbor harmony harp harvest
hawk headset heart heater heavy hello helmet helpful hero high highway hiking hill hilltop hippo history hobby hockey
holiday home hoodie hotdog hotel house huge human hundred iceberg icon idea igloo image inbox indigo inside invite
iris jacket jade january jasmine jazz jeans jeep jeju jersey jewel jigsaw jogging jolly journey judo juice july jumbo
jump jumper june jungle karate kebab ketchup kettle kimbap kimchi kimono king kingdom kitchen kite kitty kiwi koala
label ladder lagoon lake lamp lantern laptop large latte laundry leaf learn left legend lemon leopard lesson letter
lettuce level library lilac lily lime linen lion little lively lizard lobster locker london long lotus loud lucky
luggage lunch madrid magic magical magnet mailbox mandu mango maple marble march marker maroon mascot mask math mayo
meadow medal melody melon memo memory mermaid meteor metro mexico middle minivan mint minute mirror misty mitten
mobile mocha modern moment monday money monitor month morning moss mother motor movie muffin mural museum music
musical mustard nacho napkin natural nature navy neat nickel night nine ninety ninja noon north notepad nugget number
oasis oatmeal ocean october octopus office olive omelet onion online opera option orange orbit orca orchard orchid
organ origami ostrich otter outdoor outfit outside oven owner paddle paint pajama palace palm pancake panda panel
panther papaya paper parade parcel paris park parking partner party pasta pastel pastry patio peace peacock peanut
pear pebble pecan pelican pencil penguin penny pepper person pesto petal phone photo piano pickle picnic picture
pigeon piglet pilot pink pirate pitch pitcher pixel pizza planner plant plate player playful please plum pocket poem
polar polite pollen polo poncho pond poodle popcorn popular portal poster potato pottery powder present pretty pretzel
prince printer prism prize promise proud pudding puma pumpkin puppet puppy purple purse puzzle pyramid quarter queen
quest quick quiet quiz rabbit raccoon radar radio radish raft railway rainbow rainy raise raisin ramen rapid reading
ready recipe record reef relax remote resort rhino ribbon rice ripple river road robin robot rodeo rooftop room
rooster rope rosy round royal ruby ruler running safari safety sailing sailor salad salsa salt samba sand sandal
sandbox satin sauce sauna sausage scarf scene school science scooter scout screen scuba seafood seagull seal search
seaside season second secret seoul sesame seven shadow shampoo shape shark shell shield shiny shirt shop shorts shovel
shower shrimp shuttle signal silk silly silver simple singing sister sixty skate skating sketch skiing skip skyline
sled sleep sleeve slide slipper slope slow small smile smooth snack snail sneaker snowman snowy soccer sock soda soft
solve sonic sorry soup south space sparkle sparrow special speed spin spinach spiral spirit splash sponge spoon sport
spring sprout square squash squid stable stadium stage stairs stamp stapler start station statue steady steak steel
stem stereo stick sticker still stool store straw stream street student studio sturdy subway sugar suit summer summit
sunbeam sunday sunhat sunny sunrise sunset super surf surfing sushi swan sweater sweet swift swim swing sydney symbol
syrup tablet taco tadpole talent tape target taste taxi teacher teacup team teapot teddy tempo tender tennis thanks
thing thirty three thunder ticket tidy tiger timber title toast toaster today tofu tomato toolbox topaz torch toucan
tourist towel town tractor trade train trainer travel treetop trip trophy trout truck trumpet tuesday tugboat tulip
tuna tunnel turbo turkey turnip turtle tutor tuxedo twelve twenty twice twin udon uncle under unicorn uniform useful
valley vanilla vase veggie velvet victory video village violet violin visit visitor vista vitamin voice volcano voyage
waffle wagon walk wallet walnut walrus warm wasabi watch water wave weather website wedding week weekend welcome west
whale wheel white wide willow window windy winter wombat wonder workout world writer yellow yoga yogurt young zebra
zesty zipper
`.trim().split(/\s+/)

/** Digits after the word: four, 0-9. */
const DIGITS = '0123456789'
export const TEMP_PASSWORD_DIGITS = 4

/**
 * A memorable temporary password. `randomInt(n)` must return a uniformly random integer in [0, n) from a
 * cryptographic source (server: node:crypto randomInt; browser: crypto.getRandomValues with rejection sampling).
 */
export function memorablePassword(randomInt: (n: number) => number): string {
  let pw = TEMP_WORDS[randomInt(TEMP_WORDS.length)]!
  for (let i = 0; i < TEMP_PASSWORD_DIGITS; i++) pw += DIGITS[randomInt(DIGITS.length)]
  return pw
}

/** Min-entropy of memorablePassword() in bits: about 23.3. */
export const MEMORABLE_PASSWORD_BITS = Math.log2(TEMP_WORDS.length) + TEMP_PASSWORD_DIGITS * Math.log2(DIGITS.length)

/**
 * A temporary password an admin types must be printable ASCII without spaces (letters, digits, symbols). Spaces at the
 * ends are invisible on the hand-over screen, and non-ASCII text entered with a keyboard IME cannot be
 * typed into a password box on most Windows desks, so either would lock the new member out.
 */
export const tempPasswordCharsOk = (v: string): boolean => /^[\x21-\x7e]*$/.test(v)
