/**
 * Shared stop-word list used across memory search, slug generation, graph clustering,
 * and zettelkasten modules. This is the union of all per-file sets that previously
 * existed in 7 different files.
 */

export const STOP_WORDS = new Set([
  // Articles / determiners
  "a", "an", "the",
  // Conjunctions
  "and", "or", "but", "if", "then", "else", "so", "because", "as",
  "although", "however", "therefore", "thus", "hence", "meanwhile",
  "moreover", "furthermore", "otherwise", "instead", "anyway",
  // Prepositions
  "at", "to", "for", "of", "with", "by", "from", "in", "on", "out",
  "off", "over", "under", "up", "into", "without", "per", "via",
  // Pronouns
  "i", "you", "we", "they", "he", "she", "it", "me", "us", "him", "her",
  "my", "your", "our", "their", "his", "its", "who", "whom", "what",
  "which", "this", "that", "these", "those",
  // Common verbs
  "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "can", "shall",
  "want", "need", "know", "think", "see", "look", "make", "get", "go",
  "come", "take", "use", "find", "give", "tell", "say", "said", "try",
  "keep", "run", "set", "put", "add", "show", "check", "let",
  // Negation / common function words
  "not", "no", "yes", "just", "also", "very", "really",
  "about", "after", "before",
  "more", "most", "some", "any", "all", "each", "every", "both", "few",
  "many", "much", "other", "another", "such", "only", "own", "same",
  "than", "too", "ok", "okay", "sure",
  "please", "thanks", "thank", "here", "there", "now", "well", "like",
  "going", "done", "got",
  // Tech/URL junk
  "https", "http", "www", "com", "org", "net", "io",
  "null", "undefined", "true", "false",
  // Contractions (de-apostrophe'd forms that appear after tokenisation)
  "ll", "ve", "re", "don", "thats", "heres", "theres",
  "youre", "theyre", "didnt", "dont", "doesnt", "havent", "hasnt",
  "wont", "cant", "shouldnt", "wouldnt", "couldnt", "isnt", "arent",
  "wasnt", "werent",
  // Filler adverbs
  "never", "ever", "still", "already", "yet", "back",
  "away", "down", "right", "left", "next", "last", "first", "second",
  "third",
  "then", "again", "once", "twice", "since", "while", "though",
  "actually", "basically", "literally", "simply", "exactly", "probably",
  "possibly", "maybe", "perhaps", "certainly", "definitely", "absolutely",
  "completely", "totally", "quite", "rather", "fairly", "nearly",
  "almost", "barely", "hardly", "quickly", "slowly", "easily", "likely",
  "unlikely",
  // Numbers (spelled out)
  "one", "two", "three", "four", "five", "six", "seven",
  "eight", "nine", "ten",
  // Common nouns (too generic for search/slug)
  "time", "way", "thing", "something", "anything", "nothing",
  "everything", "someone", "anyone", "everyone",
  // Zettelkasten / vault-specific noise
  "new", "note", "untitled", "page", "file", "doc", "code",
  "session", "notes", "moc", "template", "content", "attachment",
  // Misc abbreviations
  "etc", "ie", "eg", "vs",
  // French stop words (for multilingual vaults)
  "les", "des", "une", "est", "que", "qui", "dans", "pour", "sur",
  "par", "pas", "son", "ses", "aux", "avec", "tout", "mais",
  // German stop words (for multilingual vaults)
  "und", "der", "die", "das", "ein", "eine", "ist", "den", "dem",
  "von", "mit", "auf", "nicht", "sich", "auch", "noch", "wie",
]);

/**
 * Alias used by graph modules that need stop-word filtering specifically for
 * vault note titles (same set, just semantically named for clarity).
 */
export const TITLE_STOP_WORDS = STOP_WORDS;
