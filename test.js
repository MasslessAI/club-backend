const deepExtend = (destination, source) => {
  for (var property in source) {
    if (typeof source[property] === 'object' && source[property] !== null) {
      destination[property] = destination[property] || {}
      deepExtend(destination[property], source[property])
    } else {
      destination[property] = source[property]
    }
  }
}
var a = {
    "content": "fuck",
    "title": "fuck",
    "itunes": {
        "summary": "75000",
        "subtitle": "Paris"
    }
};

var b = {
    "title": "Peter",
    "itunes": {
        "summary": "99999"
    }
};

deepExtend(a,b);

console.dir(a);
