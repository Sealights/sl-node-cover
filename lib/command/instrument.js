/*
 Copyright (c) 2012, Yahoo! Inc.  All rights reserved.
 Copyrights licensed under the New BSD License. See the accompanying LICENSE file for terms.
 */

var path = require('path'),
    mkdirp = require('mkdirp'),
    once = require('once'),
    async = require('async'),
    fs = require('fs'),
    filesFor = require('../util/file-matcher').filesFor,
    nopt = require('nopt'),
    Instrumenter = require('../instrumenter'),
    inputError = require('../util/input-error'),
    formatOption = require('../util/help-formatter').formatOption,
    util = require('util'),
    Command = require('./index'),
    Collector = require('../collector'),
    configuration = require('../config'),
    verbose;


/*
 * Chunk file size to use when reading non JavaScript files in memory
 * and copying them over when using complete-copy flag.
 */
var READ_FILE_CHUNK_SIZE = 64 * 1024;

function BaselineCollector(instrumenter) {
    this.instrumenter = instrumenter;
    this.collector = new Collector();
    this.instrument = instrumenter.instrument.bind(this.instrumenter);

    var origInstrumentSync = instrumenter.instrumentSync;
    this.instrumentSync = function () {
        var args = Array.prototype.slice.call(arguments),
            ret = origInstrumentSync.apply(this.instrumenter, args),
            baseline = this.instrumenter.lastFileCoverage(),
            coverage = {};
        coverage[baseline.path] = baseline;
        this.collector.add(coverage);
        return ret;
    };
    //monkey patch the instrumenter to call our version instead
    instrumenter.instrumentSync = this.instrumentSync.bind(this);
}

BaselineCollector.prototype = {
    getCoverage: function () {
        return this.collector.getFinalCoverage();
    }
};

function processFileInMemory(instrumenter, file, callback) {
    return instrumenter.instrument(file.content, file.filename, function (iErr, instrumented) {
        if (iErr) {
            file.error = iErr
        } else {
            file.instrumented = instrumented;
        }
        return callback(iErr);
    }, {
        sourceMaps: false
    });
}

//**********************************************************/
// Bug Fix: Webpack plugin breaks JavaScript code when require.ensure() is used (Duda Mobile)
// See https://sealights.atlassian.net/browse/SLDEV-2115
//
// Basically this is a workaround for:
// https://github.com/estools/escodegen/issues/336
//**********************************************************/
function removeWebpackComments(input){
    //	This regex should capture block comment filled with stars, globally.
    //	Good:
    //	    /**/
    //	    /***/
    //	    /*****************/
    //	Bad:
    //	    /*/
    //      //
    //	    /***a*/
    //	    
    var regex = new RegExp("\/[\*]{2,}\/", "g");

    while(true){
        //Execute the regex, each time on a different part of the input string.
        var currentMatch = regex.exec(input);
        if (!currentMatch)
            break;
        var matchIndex = currentMatch.index;
        var matchLength = currentMatch[0].length;
        var whiteSpace = createWhiteSpace(matchLength);

        //Replace the matching comment with whitespace.
        input = replaceAt(input, matchIndex, whiteSpace);
    }

    return input;
}

function replaceAt(string, index, replacement) {
    return string.substr(0, index) + replacement+ string.substr(index + replacement.length);
}

function createWhiteSpace(length){
	var arr = new Array(++length);
	return arr.join(" ")
}


function processFiles(instrumenter, inputDir, outputDir, relativeNames, extensions, callback, extraOpts) {
    var processor = function (name, callback) {
            var inputFile = path.resolve(inputDir, name),
                outputFile = path.resolve(outputDir, name),
                inputFileExtenstion = path.extname(inputFile),
                isJavaScriptFile = extensions.indexOf(inputFileExtenstion) > -1,
                oDir = path.dirname(outputFile),
                readStream, writeStream;

            callback = once(callback);
            mkdirp.sync(oDir);

            if (fs.statSync(inputFile).isDirectory()) {
                return callback(null, name);
            }

            if (isJavaScriptFile) {
                fs.readFile(inputFile, 'utf8', function (err, data) {
                    if (err) {
                        return callback(err, name);
                    }
                    var useRelPath = extraOpts && extraOpts.useRelativePaths;
                    data = removeWebpackComments(data);
                    instrumenter.instrument(data, inputFile, function (iErr, instrumented) {
                        if (iErr) {
                            return callback(iErr, name);
                        }
                        fs.writeFile(outputFile, instrumented, 'utf8', function (err) {
                            return callback(err, name);
                        });
                    }, {
                        filename: useRelPath ? name : inputFile
                    });
                });
            } else {
                // non JavaScript file, copy it as is
                readStream = fs.createReadStream(inputFile, {
                    'bufferSize': READ_FILE_CHUNK_SIZE
                });
                writeStream = fs.createWriteStream(outputFile);

                readStream.on('error', callback);
                writeStream.on('error', callback);

                readStream.pipe(writeStream);

                readStream.on('end', function () {
                    callback(null, name);
                });
            }
        },
        q = async.queue(processor, 10),
        errors = [],
        count = 0,
        startTime = new Date().getTime();

    q.push(relativeNames, function (err, name) {
        var inputFile, outputFile;
        if (err) {
            errors.push({
                file: name,
                error: err.message || err.toString()
            });
            inputFile = path.resolve(inputDir, name);
            outputFile = path.resolve(outputDir, name);
            fs.writeFileSync(outputFile, fs.readFileSync(inputFile));
        }
        if (verbose) {
            console.log('Processed: ' + name);
        } else {
            if (count % 100 === 0) {
                process.stdout.write('.');
            }
        }
        count += 1;
    });

    q.drain = function () {
        var endTime = new Date().getTime();
        console.log('\nProcessed [' + count + '] files in ' + Math.floor((endTime - startTime) / 1000) + ' secs');
        if (errors.length > 0) {
            console.log('The following ' + errors.length + ' file(s) had errors and were copied as-is');
            console.log(errors);
        }
        if (callback) callback(errors.length ? new Error("Some files had errors and were copied as-is") : null);
    };
}


function InstrumentCommand() {
    Command.call(this);
}

InstrumentCommand.TYPE = 'instrument';
util.inherits(InstrumentCommand, Command);

Command.mix(InstrumentCommand, {
    synopsis: function synopsis() {
        return "instruments a file or a directory tree and writes the instrumented code to the desired output location";
    },

    usage: function () {
        console.error('\nUsage: ' + this.toolName() + ' ' + this.type() + ' <options> <file-or-directory>\n\nOptions are:\n\n' + [
            formatOption('--config <path-to-config>', 'the configuration file to use, defaults to .istanbul.yml'),
            formatOption('--output <file-or-dir>', 'The output file or directory. This is required when the input is a directory, ' +
                'defaults to standard output when input is a file'),
            formatOption('-x <exclude-pattern> [-x <exclude-pattern>]', 'one or more fileset patterns (e.g. "**/vendor/**" to ignore all files ' +
                'under a vendor directory). Also see the --default-excludes option'),
            formatOption('--variable <global-coverage-variable-name>', 'change the variable name of the global coverage variable from the ' +
                'default value of `__coverage__` to something else'),
            formatOption('--embed-source', 'embed source code into the coverage object, defaults to false'),
            formatOption('--[no-]compact', 'produce [non]compact output, defaults to compact'),
            formatOption('--[no-]preserve-comments', 'remove / preserve comments in the output, defaults to false'),
            formatOption('--[no-]complete-copy', 'also copy non-javascript files to the ouput directory as is, defaults to false'),
            formatOption('--save-baseline', 'produce a baseline coverage.json file out of all files instrumented'),
            formatOption('--baseline-file <file>', 'filename of baseline file, defaults to coverage/coverage-baseline.json'),
            formatOption('--es-modules', 'source code uses es import/export module syntax')
        ].join('\n\n') + '\n');
        console.error('\n');
    },

    copyDir: function (from, to, ignoredRelFiles, callback) {
        var processedFilesLookup = {};
        ignoredRelFiles.forEach(function (f) {
            processedFilesLookup[f] = true;
        });

        var existingDirsLookup = {};

        filesFor({
            root: from,
            includes: ['**/*'],
            excludes: [],
            relative: true
        }, function (err, files) {
            if (err) {
                return callback(err);
            }
            var copyErrors = [];
            files.forEach(function (relFile) {
                if (processedFilesLookup[relFile]) return; //already processed/instrumented this earlier
                try {
                    inputFile = path.resolve(from, relFile);
                    outputFile = path.resolve(to, relFile);
                    var dir = path.dirname(outputFile);
                    if (!existingDirsLookup[dir]) {
                        mkdirp.sync(dir); //has no effect if dir already exists
                        existingDirsLookup[dir] = true;
                    }
                    var stat = fs.statSync(inputFile);
                    if (stat.isDirectory()) {
                        mkdirp.sync(outputFile); //outputFile is a directory -- create it
                        existingDirsLookup[outputFile] = true;
                    } else if (stat.isFile()) {
                        fs.writeFileSync(outputFile, fs.readFileSync(inputFile));
                    }
                } catch (e) {
                    var msg  = "Error copying file " + inputFile + " to " + outputFile + ": " + e.toString();
                    copyErrors.push(msg);
                    console.error(msg);
                }
            });

            if (copyErrors.length)
                err = new Error("Some files could not be copied:\n" + copyErrors.join('\n'));
            return callback(err);
        });
    },

    runWithSlInstrumentation: function (opts, callback) {
        if (!callback) return callback(inputError.create("callback was not specified"));
        if (!opts) return callback(inputError.create("opts was not specified"));
        if (opts.instrumentationType != "browser") return callback(inputError.create("instrumentationType must be 'browser'"));

        var hasMemoryFile = !!opts.inMemoryFile;
        var hasPhysicalFiles = opts.files && opts.files.length > 0;

        if (hasMemoryFile && hasPhysicalFiles) return callback(inputError.create("cannot instrument both physical and in-memory files"));

        if (hasPhysicalFiles) {
            if (!opts.outputPath) return callback(inputError.create("outputPath was not specified"));
            if (!opts.sourceRoot) return callback(inputError.create("sourceRoot was not specified"));
        }

        if (!opts.server) return callback(inputError.create("server was not specified"));
        if (!opts.token) return callback(inputError.create("token was not specified"));
        var _this = this;
        var agentUrl = opts.server;
        if (agentUrl[agentUrl.length] != '/')
            agentUrl += '/';
        agentUrl += 'v1/agents/browser/recommended?redirect=1&customerId=' + encodeURIComponent(opts.customerId);
        var preambleHeader = [
            "if (!window.$Sealights) window.$Sealights = " + JSON.stringify({
                customerId: opts.customerId,
                appName: opts.appName,
                buildName: opts.build,
                branchName: opts.branch,
                server: opts.server,
                token: opts.token,
                buildSessionId: opts.buildsessionid,
                labId: opts.labId, // || "browser-testing",
                enabled: true,
                workspacepath: opts.workspacepath,
                maxItemsInQueue: 500,
                registerShutdownHook: true,
                interval: 10, //in seconds
                resolveWithoutHash: opts.resolveWithoutHash,
                delayShutdownInSeconds: opts.delayShutdownInSeconds
            }, null, '  ') + ";"];

        if (opts.downloadAgent == true){
            preambleHeader.push( "if(!window.$Sealights.scriptAdded) {",
                    "   var script   = document.createElement(\"script\");",
                    "   script.type  = \"text/javascript\";",
                    "   script.src   = \"" + agentUrl + "\";",
                    "   var head     = document.head || document.getElementsByTagName && document.getElementsByTagName('head')[0]",
                    "   if (head) { head.appendChild(script); window.$Sealights.scriptAdded = true; } else { /* Unsupported/restricted browser */ }",
                    "}");
        }
        
        instrumenter = new Instrumenter({
            coverageVariable: "$SealightsCoverage",
            embedSource: false,
            noCompact: false,
            preserveComments: true,
            esModules: !!opts.esModules,
            preambleHeader: preambleHeader
        });

        if (hasMemoryFile) {
            processFileInMemory(instrumenter, opts.inMemoryFile, callback);
            return;
        } else if (hasPhysicalFiles) {
            mkdirp.sync(opts.outputPath);
            try {
                processFiles(instrumenter, opts.sourceRoot, opts.outputPath, opts.files, ['.js'], function (err) {
                    if (err) return callback(err);
                    if (opts.copyAllFilesToOutput) {
                        _this.copyDir(opts.sourceRoot, opts.outputPath, opts.files, function (err) {
                            return callback(err);
                        });
                    } else {
                        return callback();
                    }
                }, {
                    useRelativePaths: true
                });
            } catch (e) {
                return callback(e);
            }
        } else return callback();
    },

    run: function (args, callback) {

        var template = {
                config: path,
                output: path,
                x: [Array, String],
                variable: String,
                compact: Boolean,
                'complete-copy': Boolean,
                verbose: Boolean,
                'save-baseline': Boolean,
                'baseline-file': path,
                'embed-source': Boolean,
                'preserve-comments': Boolean,
                'es-modules': Boolean
            },
            opts = nopt(template, {
                v: '--verbose'
            }, args, 0),
            overrides = {
                verbose: opts.verbose,
                instrumentation: {
                    variable: opts.variable,
                    compact: opts.compact,
                    'embed-source': opts['embed-source'],
                    'preserve-comments': opts['preserve-comments'],
                    excludes: opts.x,
                    'complete-copy': opts['complete-copy'],
                    'save-baseline': opts['save-baseline'],
                    'baseline-file': opts['baseline-file'],
                    'es-modules': opts['es-modules']
                }
            },
            config = configuration.loadFile(opts.config, overrides),
            iOpts = config.instrumentation,
            cmdArgs = opts.argv.remain,
            file,
            stats,
            stream,
            includes,
            instrumenter,
            needBaseline = iOpts.saveBaseline(),
            baselineFile = path.resolve(iOpts.baselineFile()),
            output = opts.output;

        verbose = config.verbose;
        if (cmdArgs.length !== 1) {
            return callback(inputError.create('Need exactly one filename/ dirname argument for the instrument command!'));
        }

        if (iOpts.completeCopy()) {
            includes = ['**/*'];
        } else {
            includes = iOpts.extensions().map(function (ext) {
                return '**/*' + ext;
            });
        }

        instrumenter = new Instrumenter({
            coverageVariable: iOpts.variable(),
            embedSource: iOpts.embedSource(),
            noCompact: !iOpts.compact(),
            preserveComments: iOpts.preserveComments(),
            esModules: iOpts.esModules()
        });

        if (needBaseline) {
            mkdirp.sync(path.dirname(baselineFile));
            instrumenter = new BaselineCollector(instrumenter);
            process.on('exit', function () {
                console.log('Saving baseline coverage at: ' + baselineFile);
                fs.writeFileSync(baselineFile, JSON.stringify(instrumenter.getCoverage()), 'utf8');
            });
        }

        file = path.resolve(cmdArgs[0]);
        stats = fs.statSync(file);
        if (stats.isDirectory()) {
            if (!output) {
                return callback(inputError.create('Need an output directory [-o <dir>] when input is a directory!'));
            }
            if (output === file) {
                return callback(inputError.create('Cannot instrument into the same directory/ file as input!'));
            }
            mkdirp.sync(output);
            filesFor({
                root: file,
                includes: includes,
                excludes: opts.x || iOpts.excludes(false), // backwards-compat, *sigh*
                relative: true
            }, function (err, files) {
                if (err) {
                    return callback(err);
                }
                processFiles(instrumenter, file, output, files, iOpts.extensions());
            });
        } else {
            if (output) {
                stream = fs.createWriteStream(output);
            } else {
                stream = process.stdout;
            }
            stream.write(instrumenter.instrumentSync(fs.readFileSync(file, 'utf8'), file));
            if (stream !== process.stdout) {
                stream.end();
            }
        }
    }
});

module.exports = InstrumentCommand;