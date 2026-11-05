export const commentCases = [
  {
    name:'full-line and trailing comments',
    source:'# heading\nx <- 1 # value\n# ending',
    expected:'\nx <- 1 \n'
  },
  {
    name:'adjacent code and comments keep statement boundaries',
    source:'x<-1# value\nx# reference\n+2# separate expression',
    expected:'x<-1\nx\n+2'
  },
  {
    name:'normal quoted strings',
    source:'x <- "# stays"; y <- \'also # stays\' # goes\n',
    expected:'x <- "# stays"; y <- \'also # stays\' \n'
  },
  {
    name:'escaped quotes and backslashes',
    source:String.raw`x <- "a\"#b"; y <- 'it\'s # text'; z <- "\\#" # outside`,
    expected:String.raw`x <- "a\"#b"; y <- 'it\'s # text'; z <- "\\#" `
  },
  {
    name:'backticked names and escaped backticks',
    source:'`a#b` <- 1; `a\\`#b` <- 2 # outside',
    expected:'`a#b` <- 1; `a\\`#b` <- 2 '
  },
  {
    name:'ordinary raw string with embedded quotes',
    source:'x <- r"(# \'single\' and "double")" # outside',
    expected:'x <- r"(# \'single\' and "double")" '
  },
  {
    name:'hyphenated raw delimiters and alternative brackets',
    source:'x <- R"--[# ")" and ]--x]--" # outside\ny <- r\'---{# text}---\' # outside',
    expected:'x <- R"--[# ")" and ]--x]--" \ny <- r\'---{# text}---\' '
  },
  {
    name:'multiline raw and normal string contents',
    source:'x <- r"-(first\n  # literal\nlast)-" # outside\ny <- "first\n# literal\nlast" # outside\n',
    expected:'x <- r"-(first\n  # literal\nlast)-" \ny <- "first\n# literal\nlast" \n'
  },
  {
    name:'custom infix operators containing hashes and quotes',
    source:'x <- 1 %#% 2 # outside\ny <- 3 %a"#b% 4 # outside',
    expected:'x <- 1 %#% 2 \ny <- 3 %a"#b% 4 '
  },
  {
    name:'Unicode names, literals and comments',
    source:'café <- "# 中文 🦉" # notes é\n`结果#值` <- café # 注释\n',
    expected:'café <- "# 中文 🦉" \n`结果#值` <- café \n'
  },
  {
    name:'nested calls, continuations and else',
    source:'{\n  x <- sum( # first\n    1, # second\n    2\n  ) # end call\n  if (x > 0) x # true\n  else 0 # false\n}\n',
    expected:'{\n  x <- sum( \n    1, \n    2\n  ) \n  if (x > 0) x \n  else 0 \n}\n'
  },
  {
    name:'Windows line endings',
    source:'# heading\r\nx<-1# inline\r\nx+1# last',
    expected:'\r\nx<-1\r\nx+1'
  },
  {
    name:'carriage-return line endings',
    source:'# heading\rx<-1# inline\rx+1# last',
    expected:'\rx<-1\rx+1'
  },
  {
    name:'shebangs, roxygen and empty comment lines',
    source:'#!/usr/bin/env Rscript\n#\n#\' description\n1 # final\n',
    expected:'\n\n\n1 \n'
  },
  {
    name:'comment-only source and final newline',
    source:'  # first\n\t# second\n',
    expected:'  \n\t\n'
  }
];
