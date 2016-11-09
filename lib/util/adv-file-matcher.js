//Same as File-matcher, but also scans for npm packages that have a "sealights" section in their package.json.
//matcherFor returns metadata for matched files (not just 'true')

var async = require('async'),
    fileset = require('fileset'),
    fs = require('fs'),
    path = require('path'),
    simpleFilesFor = require('./file-matcher.js').filesFor,
    findNpmPackages = require('./find-npm-packages.js');

function filesFor(options, callback) {
    if (!callback && typeof options === 'function') {
        callback = options;
        options = null;
    }
    options = options || {};

    var root = options.root,
        includes = options.includes,
        excludes = options.excludes,
        realpath = options.realpath,
        relative = options.relative,
        opts;

    root = root || process.cwd();
    includes = includes && Array.isArray(includes) ? includes : ['**/*.js'];
    excludes = excludes && Array.isArray(excludes) ? excludes : ['**/node_modules/**'];

    var allFiles = [];

    //Find all files in the currently running project
    fileForWithMetadata(options, function (err, mainFiles) {
        if (err) {
            return callback(err);
        }
        allFiles = allFiles.concat(mainFiles);

        if (!options.scanDeps) {
            return callback(null, allFiles);
        }
        //Find files in npm packages that contain a sealights section
        findNpmPackages(root, function (err, foundNpmPackages) {
            if (err) {
                return callback(err);
            }

            function processNextNpmPackage() {
                if (foundNpmPackages.length == 0) { //No more packages to scan, invoke the callback
                    return callback(null, allFiles);
                }

                var pkg = foundNpmPackages.shift();
                try {
                    if (pkg.path == root) {
                        return processNextNpmPackage(); //Skip this module, it is main.
                    }

                    var sealightsJsonName = path.join(pkg.path, "sealights.json");
                    getSealightsAppDataFromSealightsJsonFile(sealightsJsonName, function (err, appData) {
                        if (err) {
                            return processNextNpmPackage();
                        }

                        //clone options
                        var pkgOptions = clone(options);
                        pkgOptions.root = pkg.path;
                        warnIfInvalidAppData(appData, sealightsJsonName);

                        fileForWithMetadata(pkgOptions, function (err, pkgFiles) {
                            if (err) {
                                return callback(err);
                            }
                            allFiles = allFiles.concat(pkgFiles);
                            processNextNpmPackage();

                        }, { appData: { appName: appData.appName, buildName: appData.buildName, branchName: appData.branchName, rootPath:pkg.path } }); //take only appName, buildName, branchName
                    });
                } catch (pkge) {
                    return processNextNpmPackage();
                }
            }

            processNextNpmPackage();
        });

    }, { appData: { appName: '', branchName: '', buildName: '' } });

    function warnIfInvalidAppData(appData, sealightsJsonName) {
        if (appData && !appData.appName) {
            console.log('appName was not found in ' + sealightsJsonName);
        }
        if (appData && !appData.branchName) {
            console.log('branchName was not found in ' + sealightsJsonName);
        }
        if (appData && !appData.buildName) {
            console.log('buildName was not found in ' + sealightsJsonName);
        }
    }

    function fileForWithMetadata(options, cb, metadataPrototype) {
        simpleFilesFor(options, function (err, files) {
            if (err) {
                return cb(err);
            }
            var filesWithMetadata = [];
            var root = options.root.replace(/\\/g, '/');
            for (var i = 0; i < files.length; i++) {
                fileMd = {};
                //copy all properties from metadata into fileMd
                Object.keys(metadataPrototype).forEach(function (k) { fileMd[k] = metadataPrototype[k]; });
                var fullPath = files[i].replace(/\\/g, '/');
                if (fullPath.indexOf(root.replace(/\\/g, '/')) === 0) {
                    relativePath = fullPath.substring(root.length + 1);
                    fileMd.relativePath = relativePath;
                }
                else {
                    console.warn('Excluding file from analysis ' + fullPath + ', as it is not under the project root ' + root);
                }
                filesWithMetadata.push({ filename: files[i], metadata: fileMd });
            }
            cb(null, filesWithMetadata);
        });
    }

    function getSealightsAppDataFromSealightsJsonFile(filePath, callback) {
        fs.readFile(filePath, 'utf8', function (err, data) {
            if (err) {
                return callback(err);
            }
            try {
                var jsonData = JSON.parse(data);
                if (jsonData && jsonData.appName) {
                    callback(null, jsonData);
                }
                else {
                    return callback('required data was not found in sealights.json');
                }

            }
            catch (e) {
                callback(e);
            }
        });
    }

    function clone(o) {
        return JSON.parse(JSON.stringify(o));
    }
}

function matcherFor(options, callback) {

    if (!callback && typeof options === 'function') {
        callback = options;
        options = null;
    }
    options = options || {};
    options.relative = false; //force absolute paths
    options.realpath = true; //force real paths (to match Node.js module paths)

    filesFor(options, function (err, filesWithMetadata) {
        var fileMap = {},
            matchFn;
        if (err) { return callback(err); }
        filesWithMetadata.forEach(function (file) { fileMap[file.filename] = file.metadata; });

        matchFn = function (file) { return fileMap[file]; };
        matchFn.files = Object.keys(fileMap);
        return callback(null, matchFn);
    });
}

module.exports = {
    filesFor: filesFor,
    matcherFor: matcherFor
};