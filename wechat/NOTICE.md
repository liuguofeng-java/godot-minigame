# Third-party runtime provenance

`weapp-adapter.js` is the readable webpack bundle inherited from
`demo/wxgame/weapp-adapter.js` in this repository's initial public commit
`0530780`. It implements the WeChat browser compatibility layer. Its module
boundaries and existing comments are preserved. The inherited file does not
identify an exact upstream revision or carry a separate license header; this
repository does not claim to have recovered its original module sources or to
have authored the bundle. Its upstream provenance needs confirmation before
independent redistribution under a different license.

The readable `engine/godot-sdk.js` and `godot-loader.js` were migrated from this
repository's public minimal runtime. They are not decompiled versions of the
old minified SDK.

The engine source overlay `library_blob.js` retains the MIT notice naming
Eli Grey and Jimmy Wärting. Other inherited Godot source notices remain in place.
Godot itself is fetched from the official repository with its original license.
