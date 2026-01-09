
var rotatingLogStream = require('../../file-stream-rotator').getStream({
    filename:"logs/nodate/logfile", 
    verbose: true, 
    size:"50k",
    // max_logs: "5", 
    audit_file:"audit-nodate.json",
    end_stream: false,
    extension: ".log",
    buffer_size: 20
});

rotatingLogStream.on("error",function(err){
    console.log(Date.now(), Date(), "stream error", err)
    process.exit()
})


rotatingLogStream.on("close",function(){
    console.log(Date.now(), Date(), "stream closed")
})

rotatingLogStream.on("finish",function(){
    console.log(Date.now(), Date(), "stream finished")
})

rotatingLogStream.on("rotate",function(oldFile,newFile){
    console.log(Date.now(), Date(), "stream rotated",oldFile,newFile);
})

rotatingLogStream.on("open",function(fd){
    console.log(Date.now(), Date(), "stream open",fd);
})

rotatingLogStream.on("new",function(newFile){
    console.log(Date.now(), Date(), "stream new",newFile);
})

rotatingLogStream.on("addWatcher", function(newLog){
    console.log(Date.now(), Date(), "stream add watcher",newLog);
})

// console.log(rotatingLogStream.on, rotatingLogStream.end, rotatingLogStream)

var counter = 0;
while(counter < 200) {
    counter++;
    // rotatingLogStream.write(Date() + "\ttesting 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890-testing 1234567890\n")
    rotatingLogStream.write(Date() + "ニューバランスの100年を超える長い歴史\n")
    rotatingLogStream.write(Date() + "\t");
    rotatingLogStream.write("\n");
}
console.log("Drops: ", rotatingLogStream.drops);

