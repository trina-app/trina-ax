// Memorable temporary passwords: one easy English word + digits, e.g. "tiger427", "maple385", "lake4827".
//
// Used wherever the system makes a temporary password (admin "add member" and "new temporary password", the admin
// form that pre-fills one to hand over). A temporary password is one-time: the person must change it at first
// sign-in, it stops working TEMP_PASSWORD_TTL_DAYS days after it was set, and the server voids it after
// TEMP_PASSWORD_MAX_FAILURES wrong tries (server/src/auth/accounts.ts). So it trades length for being easy to read out
// and type at a clinic desk.
//
// Format: a word of 4-7 lower-case letters from TEMP_WORDS, then digits 2-9 (no 0/1, which read as O/l): three of
// them, four after a 4-letter word, so every password has 8-10 characters and passes the 8-character rule.
//
// Entropy (min-entropy = the chance of the single most likely password): log2(2114) + 3 x log2(8) = 20.0 bits, about
// one in a million. That is weak against offline cracking and is only acceptable because guessing is online only:
// argon2id hashes, 10 failed sign-ins / 15 min per account (30 per IP), voided after 20 wrong tries (so a guesser
// wins with at most 20 / 2^20 = 0.002%), valid for 7 days, replaced by the person's own password at first sign-in.
// (Reaching ~30 bits would need two words or six digits, which is no longer "about 8 characters".)
//
// TEMP_WORDS: common words, mostly from the BIP-0039 English list (unique 4-letter prefixes, so no two words look
// alike), without unpleasant, violent, medical-worry, gendered or slangy words, plus easy nature / food / animal /
// object words. Lower-case a-z only, 4-7 letters, no duplicates (tests/unit/a-auth.test.ts checks this).

export const TEMP_PASSWORD_TTL_DAYS = 7
export const TEMP_PASSWORD_MAX_FAILURES = 20

export const TEMP_WORDS: readonly string[] = `
ability able about above absorb access account achieve acid acorn acquire across action actor actual adapt address
adjust admit advance advice aerobic afford again agent agree ahead airport aisle alarm album alert alley allow almond
almost alone alpaca alpha already also alter always amateur amazing amber among amount amused analyst anchor ancient
angle animal ankle annual another answer antenna antique apart appear apple approve apricot april apron arch arctic
area arena argue armor around arrange arrive arrow artist artwork aspect aspen asset assist assume athlete atom
attend attic attract auction audit august aunt aurora author auto autumn average avocado avoid awake aware away
awesome axis azure baby badge badger bagel baker bakery balance balcony ball ballet balloon bamboo banana banjo
banner barely bargain barn barrel base basic basil basket beach beacon beagle bean bear beauty beaver because become
beet beetle before begin behave behind beige believe bell below belt bench benefit berry best better between beyond
bicycle bike bind biology birch bird birth biscuit bison black blanket bloom blossom blouse blue blur blush board
boat body boil bold bone bonus book boost border borrow boss bottle bottom boulder bounce bowling bracket brain
branch brand brass brave bread breeze breezy brick bridge brief bright bring brisk bronze brook broom brother brown
brownie brush bubble bucket buddy budget buffalo build bulb bulk bundle bunny burger burst busy butter button buzz
cabbage cabin cable cactus cafe cake calf call calm camel camera camp canal candle candy canoe canvas canyon capable
capital captain caramel carbon card cargo carpet carrot carry cart case cash cashew castle casual catalog catch
cattle caught cause caution cave cedar ceiling celery cello cement century cereal certain chair chalk change chapter
charge chase chat cheap check cheddar cheer cheery cheese cheetah chef cherry chess chest chicken chief child chili
chimney chips choice choose chorus chuckle chunk churn cinema circle circus citizen citrus city civil claim clap
clarify clay clean clerk clever click client cliff climb clinic clip clock close cloth cloud clove clover club clump
cluster clutch coach coast cobalt cocoa coconut code coffee coil coin collect collie color column combine come comet
comfort comic common company compass concert condor conduct confirm connect control cook cookie cool copper copy
coral core corn correct cosmos cost cottage cotton couch country couple course cousin cover coyote cozy crab crack
cracker cradle craft cram crane crater crawl crayon cream credit creek crepe crew cricket crimson crisp crop cross
crouch crow crowd crown crucial cruise crumble crunch crystal cube culture cumin curious curly current curry curtain
curve cushion custom cute cyan cycle cypress dahlia dairy daisy damp dance dancer dandy daring dash dawn deal debate
decade decide deer defense define defy degree delay deliver delta demand denim dentist depart depend deposit depth
deputy derive desert design desk detail detect develop device devote diagram dial diamond diary dice diesel diet
differ digital dignity dilemma dingo dinner direct disco dish display divide doctor doll dolphin domain domino donate
donkey donor donut door double dove draft dragon drama draw dream dreamy dress drift drill drink drip drive drop drum
drummer duck dune during dust duty dynamic eager eagle early earn earth easel easily east easy echo ecology economy
edge edit educate effort eight either elbow elder elegant element elite else embark ember embody embrace emerald
emerge emotion employ empower empty enable enact endless endorse energy enforce engage engine enhance enjoy enlist
enough enrich enroll ensure enter entire entry episode equal equip erase erupt escape essay essence estate eternal
ethics evening evoke evolve exact example excess excite exclude execute exhibit exist exit exotic expand expect
explain express extend extra eyebrow fable fabric face faculty fade faint faith falcon fall fame family famous fancy
fantasy farm farmer fashion father fawn feather feature feed feel fence fern ferret ferry fetch fiber fiction fiddle
field fiesta figure file film filter final finch find fine finger finish fire firefly firm first fish fitness fjord
flag flame flash flat flavor flight flint flip float flock floor flora flower fluffy fluid flush flute foal foam
focus foil fold follow food foot force forest forget fork fortune forum forward fossil foster found fragile frame
fresh friday friend fringe frog front frost frozen fruit fudge fuel funny furnace future gadget gain galaxy gallery
game garage garden garlic garment garnet gate gather gauge gaze gazebo gecko general genius genre gentle genuine
gesture geyser ghost giant gibbon gift giggle ginger giraffe give glacier glad glade glance glare glass glide glider
glimpse globe glory glossy glove glow glue goat gold golden golf good goose gorilla govern gown grab grace grain
grand granola grant grape grass gravel gravity gravy great green grid grit grocery group grove grow guard guava guess
guest guide guitar gust habit hair half hamlet hammer hammock hamster hand handy happy harbor hard hare harmony harp
harsh harvest hatch have hawk hazel head health heart heath heather heavy hedge height hello helmet help helper hero
heron hidden high hiker hiking hill hint hippo hire history hobby hockey hold hole holiday hollow home honest honey
hood hoop hope horizon horn horror horse host hotel hour hover huge human humble humor hundred hungry hurdle hurry
husky hybrid ibis iceberg icon idea igloo ignore iguana image imitate immense immune impact impala impose improve
impulse inch include income index indigo indoor infant inform inhale inherit initial inlet inner input inquiry insect
inside inspire install intact into invest invite involve iris iron island issue item ivory jacket jade jaguar jasmine
jazz jeans jelly jewel jigsaw join joke jolly journey joyful judge juice july jump june jungle junior juniper just
kale karate kayak keen keep kernel ketchup kettle khaki kick kind kingdom kiosk kitchen kite kitten kiwi knee knife
knock knot know koala label labor ladder ladybug lagoon lake lamb lamp lantern laptop large lark latch later latin
laugh laundry laurel lava lawn layer leader leaf learn leave lecture ledge leek left legal legend leisure lemon lemur
lend length lens lentil leopard lesson letter level lever liberty library license life lift light like lilac lily
limb lime limit linen link lion liquid list little live lively lizard llama load loan lobster local lock locket lodge
loft logic long loop lotus loud lounge love loyal lucky luggage lumber lumen lunar lunch luxury lychee lynx lyric
macaw machine magenta magic magnet magpie mail main major make mammal manage mango manor mansion mantle manual maple
marble march margin marina marine market marmot maroon marsh mask mass master match math matrix matter mauve maximum
maze meadow mean measure medal media meerkat mellow melody melon melt member memory mention menu mercy merge merit
merry mesh message metal meteor method middle mighty milk mill million mimic mind minimum mink minor mint minute
miracle mirror miss mist mitten mixed mixture mobile mocha model modest modify moment monday monitor monkey month
moon moose moral more morning mosaic moss motel moth mother motion motor mouse move movie much muffin mule mural
muscle museum music must mutual myrtle myself mystery myth nacho name napkin narrow nation nature navy near neat
nebula neck nectar need needle neither nephew nerve nest network neutral never news newt next nice night nimble noble
noise noodle noon normal north nose notable note nothing notice novel nugget number nurse nutmeg oasis oatmeal oats
obey object oblige observe obtain obvious occur ocean ocelot ochre october offer office often okapi okay olive
olympic omit once onion online only opal open opera opinion oppose option orange orbit orca orchard orchid order
organ orient ostrich other otter outdoor outer outpost output outside oval oven over owner oxygen oyster ozone pact
paddle page pagoda painter pair palace palette palm pancake panda panel panther pantry papaya paper parade parcel
parent park parka parrot party pass pasta pastel patch path patient patio patrol pattern pause pave payment peace
peach peanut pear pearl pebble pecan pelican pencil penguin peony people pepper perch perfect permit person pesto
petal phone photo phrase pianist piano pickle picnic picture piece pier pigeon piglet pillar pillow pilot pine pink
pinto pioneer pipe pitch pixel pixie pizza place planet plank plastic plate play player plaza please pledge pluck
plucky plug plum plunge pocket poem poet point polar pole police polite polka pollen pond pony poodle pool popcorn
poppy popular porch portion post potato potter pottery powder power prairie praise predict prefer prepare present
pretty pretzel prevent price pride primary print prism private prize process produce profit program project promote
proof prosper protect proud provide public pudding puffin pull pulley pulse puma pumpkin pupil puppy purity purpose
purse push puzzle pyramid quail quality quantum quarter quartz quest quick quiet quilt quinoa quit quiver quiz quote
rabbit raccoon race rack radar radio radish raft rail rain rainbow raise raisin rally ramen ramp ranch random range
ranger rapid rare rate rather raven razor ready real reason rebuild recall receive recipe record recycle reduce reed
reef reflect reform refuse region regular relax relay release relief rely remain remind remove render renew rent
reopen repair repeat replace report require rescue resist result retire return reunion reveal review reward rhythm
ribbon rice rich riddle ride ridge right rigid ring ripple risk ritual rival river road roast robin robot robust
rocket rodeo romance roof rooftop rookie room rose rosy rotate rough round route rover rowing royal rubber ruby rule
runway rural rust saddle safe saffron saga sage sail sailing sailor salad salmon salon salsa salt salute samba same
sample sand sandal sandbox sapling satin satisfy sauce savanna save scale scan scarf scarlet scatter scene scheme
school science scone scooter scout scrap screen script scroll scrub seal search season seat second secret section
seed seek segment select seminar senior sense sepia series service sesame session settle setup seven shadow shaft
shallow share shed shelf shell sheriff shield shift exampleteam shiny ship shiver shock shoe shop shore short shovel shrimp
shrug shuffle sibling side sierra sight sign signal silent silk silky silly silver similar simple since sing singer
siren sister situate size skate sketch skiing skill skin skirt skylark slab sled sleek sleep slender slice slide
slight slim slipper slogan slope slot sloth slow slush small smart smile smooth snack snail snake snap sniff snow
snowy soap soccer social sock soda sofa soft solar solid solve someone song sonic sonnet soon sorbet sorry sort soul
sound soup source south space spare spark sparrow spatial spawn speak special speed spell spend sphere spice spider
spike spin spinach spindle spirit splash split sponsor spool spoon sport spot spray spread spring sprint sprout
spruce square squeeze squid stable stadium staff stage stairs stamp stand star start state statue stay steady steel
stem stencil step stereo stick still stitch stock stone stool stork storm story stove straw stream street strong
student studio stuff sturdy style subject submit subway success such sudden sugar suggest suit summer summit sunday
sundial sunlit sunny sunrise sunset super supply supreme sure surface surfing surge survey sushi sustain swallow
swamp swan swap swarm sweet swift swim swing switch symbol syrup system table tablet tackle taco tadpole tail tailor
talent talk tango tank tape tapir target task tassel taste taxi teach teacher teacup teal team teapot tell tempo
tender tennis tent term terrier test text thank that theater theme then theory there they thimble thing this thistle
thought thread three thrive throw thumb thunder thyme tiara ticket tide tidy tiger tilt timber time tiny tissue title
toast today toddler toffee tofu token tomato tone tonight tool tooth topaz topic topple torch tornado toss total
toucan tourist toward towel tower town track tractor trade traffic trail train tram travel tray treat tree trellis
trend trial tribe trick trim trip tripod trophy trout truck true truly trumpet trust truth tube tuesday tuition tulip
tumble tuna tundra tunnel turkey turn turtle tuxedo twelve twenty twice twig twin twist type typical umber unaware
uncle uncover under undo unfold uniform unique unit unknown unlock until unusual unveil upbeat update upgrade uphold
uplift upon upper urban urge usage used useful usual utility vacuum valid valley valve vanilla vanish vapor various
vase vast vault vehicle velvet vendor venture venue verb verify version very vessel veteran viable vibrant victory
video view village vintage violet violin virtual visa visit vista visual vital vivid vocal voice volcano volume vote
voyage wafer waffle wagon wait walk wall wallet walnut walrus waltz wand want warm wash wasp water wave wealth wear
weasel weather weave wedding weekend welcome west whale what wheat wheel when where whip whisper whistle wicker wide
widget width wild will willow wind window wine wing wink winner winter wire wisdom wise wish witness witty wolf
wombat wonder wood wool word work world worth wrap wren wrist write writer yacht yard yarn year yellow yodel yoga
yogurt young youth zebra zenith zephyr zero zesty zigzag zipper zone`.trim().split(/\s+/)

/** Digits used after the word: 2-9 (0 and 1 look like O and l). */
const DIGITS = '23456789'

/**
 * A memorable temporary password. `randomInt(n)` must return a uniformly random integer in [0, n) from a
 * cryptographic source (server: node:crypto randomInt; browser: crypto.getRandomValues with rejection sampling).
 */
export function memorablePassword(randomInt: (n: number) => number): string {
  const word = TEMP_WORDS[randomInt(TEMP_WORDS.length)]!
  let digits = ''
  for (let i = Math.max(3, 8 - word.length); i > 0; i--) digits += DIGITS[randomInt(DIGITS.length)]
  return word + digits
}

/** Min-entropy of memorablePassword() in bits (a 5-7 letter word and three digits): about 20. */
export const MEMORABLE_PASSWORD_BITS = Math.log2(TEMP_WORDS.length) + 3 * Math.log2(DIGITS.length)
