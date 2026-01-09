import * as fs from "fs";
import { rename } from "fs/promises";
import path = require('path');

import type { FileStreamRotatorOptions, FileStreamRotatorConfig, AuditSettings } from "./types";
import { KeepLogFiles, Frequency } from "./enums";

import DefaultOptions from "./DefaultOptions";
import Rotator from "./Rotator";
import AuditManager from "./AuditManager"
import { Logger, makeDirectory } from "./helper";
import EventEmitter = require("events");

export default class FileStreamRotator extends EventEmitter {
    static getStream(options: Partial<FileStreamRotatorOptions>): FileStreamRotator {
        return new FileStreamRotator(options)
    }
    private dropCount = 0;
    private writeBuffer: {str: string, encoding?: BufferEncoding}[] = [];
    private writing = false;
    private rotatePromise: Promise<void> | undefined;
    private config: FileStreamRotatorConfig = {};
    private fs?: fs.WriteStream;
    private rotator: Rotator;
    private currentFile?: string;
    private auditManager: AuditManager;
    private maxBufferSize = 10000;
    private renaming = false;
    private writingEndedCB: (() => void) | null = null;
    // private logWatcher?: FSWatcher

    constructor(options: Partial<FileStreamRotatorOptions>, debug: boolean = false){
        super();
        this.config = this.parseOptions(options);
        Logger.getInstance(options.verbose, debug);

        this.auditManager = new AuditManager(this.config.auditSettings ?? DefaultOptions.auditSettings({}), this);
        let lastEntry = this.auditManager.config.files.slice(-1).shift();
        this.rotator = new Rotator((this.config.rotationSettings ?? DefaultOptions.rotationSettings({})), lastEntry);
        this.currentFile = this.rotator.getNewFilename();;
        this.createNewLog(this.currentFile);
        this.emit('new', this.currentFile);
    }

    private parseOptions(options: Partial<FileStreamRotatorOptions>): FileStreamRotatorConfig {
        let config: FileStreamRotatorConfig = {};
        config.options = DefaultOptions.fileStreamRotatorOptions(options);
        config.fileOptions = DefaultOptions.fileOptions(options.file_options ?? {});

        if (options.buffer_size) {
            const val = Number(options.buffer_size);
            if (!isNaN(val)) {
                this.maxBufferSize = val;
            }
        }
        let auditSettings: AuditSettings = DefaultOptions.auditSettings({});
        if (options.audit_file) {
            auditSettings.auditFilename = options.audit_file
        }
        if (options.audit_hash_type) {
            auditSettings.hashType = options.audit_hash_type
        }
        if (options.extension){
            auditSettings.extension = options.extension
        }
        if (options.max_logs) {
            let params = DefaultOptions.extractParam(options.max_logs)
            auditSettings.keepSettings = {
                type: params.letter?.toLowerCase() == "d" ? KeepLogFiles.days : KeepLogFiles.fileCount,
                amount: params.number
            }
        }
        config.auditSettings = auditSettings

        config.rotationSettings = DefaultOptions.rotationSettings({filename: options.filename, extension: options.extension})
        if (options.date_format && !options.frequency){
            config.rotationSettings.frequency = Frequency.date
        } else {
            config.rotationSettings.frequency = Frequency.none
        }
        
        if (options.date_format) {
            config.rotationSettings.format = options.date_format
        } 
        config.rotationSettings.utc = options.utc ?? false
        switch(options.frequency){
            case "daily":
                config.rotationSettings.frequency = Frequency.daily
                break
            case "custom":
            case "date":
                config.rotationSettings.frequency =  Frequency.date
                break
            case "test":
                config.rotationSettings.frequency = Frequency.minutes
                config.rotationSettings.amount = 1
                break
            default:
                if (options.frequency){
                    let params = DefaultOptions.extractParam(options.frequency)
                    if (params.letter?.match(/^([mh])$/)) {
                        config.rotationSettings.frequency = params.letter == "h" ? Frequency.hours : Frequency.minutes
                        config.rotationSettings.amount = params.number
                    }
                }
        }
        if (options.size) {
            let params = DefaultOptions.extractParam(options.size)
            switch(params.letter){
                case 'k':
                    config.rotationSettings!.maxSize = params.number*1024
                    break
                case 'm':
                    config.rotationSettings!.maxSize = params.number*1024*1024
                    break
                case 'g':
                    config.rotationSettings!.maxSize = params.number*1024*1024*1024
                    break
            }
        }
        config.rotationSettings.keepSettings = auditSettings.keepSettings;
        this.rotator = new Rotator(config.rotationSettings);
        return config;
    }

    get drops(): number {
        return this.dropCount;
    }
    
    async renameFile(newName: string): Promise<void> {
        const oldName = this.rotator.settings.filename;
        if (oldName === newName) {
            return;
        }

        const oldFile = this.currentFile;
        if (oldFile == null) {
            return;
        }

        this.renaming = true;
        if (this.fs) {
            const writingEndedPromise = new Promise<void>((resolve) => {
                this.writingEndedCB = resolve;
            });
            if (this.writing) {
                await writingEndedPromise;
                this.writingEndedCB = null;
            }
            const fs = this.fs;
            this.fs = undefined;
            if(this.config.options?.end_stream === true){
                fs.end();
            }else{
                fs.destroy();
            }
        }
        this.rotator.settings.filename = newName;
        this.currentFile = this.rotator.getNewFilename();
        await rename(oldFile, this.currentFile);
        this.createNewLog(this.currentFile);        
        this.emit('new', this.currentFile);
        this.renaming = false;
    }

    rotate(force: boolean = false) {
        let oldFile = this.currentFile;
        this.rotator.rotate(force);
        this.currentFile = this.rotator.getNewFilename();

        // oldfile same as new file. do nothing
        if (this.currentFile == oldFile) {
            return;
        }

        // close old file and watcher if exists.
        if (this.fs) {
            // if (this.logWatcher) {
            //     this.logWatcher.close()
            // }
            if(this.config.options?.end_stream === true){
                this.fs.end();
            }else{
                this.fs.destroy();
            }
        }

        // add old file to audit
        if (oldFile){
            this.auditManager.addLog(oldFile)
        }

        this.createNewLog(this.currentFile);
        this.emit('new', this.currentFile);
        if (this.config.options?.rotate && oldFile) {
            this.rotatePromise = this.config.options.rotate(oldFile)
            .catch(() => {/* do nothing */ })
            .then(() => {
                this.rotatePromise = undefined;
            });
        }
        this.emit('rotate', oldFile, this.currentFile, force);
    }

    private createNewLog(filename: string) {
        // create new directory if required
        makeDirectory(filename)


        // add mew file tp audit
        this.auditManager.addLog(filename)

        // create new file
        let streamOptions: any = {}
        if (this.config.fileOptions) {
            streamOptions = this.config.fileOptions
        }
        this.fs = fs.createWriteStream(filename, streamOptions)

        // setup dependencies: proxy events, emit events
        this.bubbleEvents(this.fs, filename)

        // setup symlink
        if (this.config.options?.create_symlink){
            this.createCurrentSymLink(filename)
        }
    }

    async #write(): Promise<void> {
        if (this.fs == null) {
            return;
        }
        if (this.renaming) {
            this.writing = false;
            if (this.writingEndedCB) {
                this.writingEndedCB();
            }
            return;
        }
        const buffers = this.writeBuffer.splice(0);
        for(const buffer of buffers) {
            if (this.rotatePromise != null) {
                try {
                    await this.rotatePromise;
                } catch{}
            }
            await new Promise<void>(resolve => {
                if (this.fs) {
                    this.fs.write(buffer.str, buffer.encoding || "utf8", err => {
                        if (err == null) {
                            this.rotator.addBytes(Buffer.byteLength(buffer.str, buffer.encoding));
                        }
                        resolve();
                    });
                }
            });
            if (this.rotatePromise == null && this.rotator.hasMaxSizeReached()){
                this.rotate();
            }
        }
        if (this.writeBuffer.length > 0) {
            await this.#write();
        } else {
            this.writing = false;
            if (this.writingEndedCB) {
                this.writingEndedCB();
            }
        }
    }

    write(str: string, encoding?: BufferEncoding) {
        if (this.maxBufferSize != 0 && this.writeBuffer.length < this.maxBufferSize) {
            this.writeBuffer.push({str, encoding});
        } else {
            this.dropCount++;
        }
        if (this.writing) {
            return;
        }
        this.writing = true;
        this.#write();
    }

    flush(cb?: () => void) {
        this.#write()
        .then(() => {
            if (cb) cb();
        });
     }

    end(str: string) {
        if (this.fs){
            this.fs.end(str);
            this.fs = undefined
        }        
    }
    
    private bubbleEvents(emitter: EventEmitter, filename: string) {
        emitter.on('close',() => { this.emit('close') })
        emitter.on('finish',() => { this.emit('finish') })
        emitter.on('error',(err) => { this.emit('error',err) })
        emitter.on('open',(fd) => { this.emit('open',filename) })
    }

    private createCurrentSymLink(logfile?: string) {
        if (!logfile) {
            return
        }
        let symLinkName = this.config.options?.symlink_name ?? "current.log"
        let logPath = path.dirname(logfile)
        let logfileName = path.basename(logfile)
        let current = logPath + path.sep + symLinkName
        try {
            if (fs.existsSync(current)){
                let stats = fs.lstatSync(current)
                if(stats.isSymbolicLink()){
                    fs.unlinkSync(current)
                    fs.symlinkSync(logfileName, current)
                    return
                }
                Logger.verbose("Could not create symlink file as file with the same name exists: ", current);
            } else {
                fs.symlinkSync(logfileName, current)
            }
        } catch (err: any) {
            Logger.verbose("[Could not create symlink file: ", current, ' -> ', logfileName);
            Logger.debug("error creating sym link", current, err)
        }
    }


    test(): {config: FileStreamRotatorConfig, rotator: Rotator} {
        return {config: this.config, rotator: this.rotator}
    }

}
