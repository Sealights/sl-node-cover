var exec = require('child_process').exec, 
    path = require('path'),
    fs = require('fs');

/**
 * Finds all NPM package folders under the specified root
 * This method uses two implementations:
 *  1. Use 'npm ll' command. This may fail is npm is not in the path, in which case the fallback is:
 *  2. Use the 'require' package, specifically a private inner module that lists all node_module paths under a root.
 */
function findNpmPackages(root, callback) {
    try {
        findNpmPackages_npm(root, function (err, packages) {
            if (err) {
                findNpmPackages_unsafe(root, callback);
            }
            else {
                callback(err, packages);
            }
        });
    }
    catch (e) {
        //Try the fallback
        findNpmPackages_unsafe(root, callback);
    }
}

/**
 * Parse 'npm ll --parseable' output, and appends it to packagesArray
 */
function parseAndAppendPackages(stdout, type) {
    var packagesArray = [];
    var lines = stdout.split('\n');
    lines.forEach(function (line) {
        if (!line || !line.length) return;
        var path = '';
        if (line[0] == '/') {
            path = line.split(':')[0]; //linux, macOS, etc.
        }
        else {
            var firstSlash = line.indexOf('\\'); //Windows
            if (firstSlash < 0) { return; }
            var nextColon = line.indexOf(':', firstSlash);
            if (nextColon < 0) { return; }
            path = line.substring(0, nextColon);
        }
        packagesArray.push({ type: type, path: path });
    });
    return packagesArray;
}

function findNpmPackages_npm(root, callback) {
    var ERROR_MESSAGE = 'Could not produce a list of NPM packages using "npm ll". Other packages may not be instrumented and may not send footprints.';
    var packages = [];
    var child = exec('npm ll --parseable',
        function (error, stdout, stderr) {
        if (error) {
            console.log(ERROR_MESSAGE);
            return callback(error, null);
        }
        try {
            packages = packages.concat(parseAndAppendPackages(stdout, 'local'));
        } catch (e) {
            return callback(e, null);
        }
        
        var child2 = exec('npm -g ll --parseable',
        function (error, stdout, stderr) {
            if (error) {
                console.log(ERROR_MESSAGE);
                return callback(error, null);
            }
            
            try {
                parseAndAppendPackages(stdout, packages, 'global');
            } catch (e) {
                return callback(e, null);
            }
            callback(null, packages);
        });
    });
}


function findNpmPackages_unsafe(root, callback) {
    try {
        //VERY HACKISH, DANGEROUS, UNSAFE way of doing this. This should be done after other attempts have failed
        var loadedModules = Object.keys(require.cache);
        var nodeModulesPathsModuleKey = loadedModules.filter(function (t) { return path.basename(t) == "node-modules-paths.js"; });
        if (nodeModulesPathsModuleKey.length == 1) {
            var nodeModulesPathsModule = require.cache[nodeModulesPathsModuleKey];
            var modulePaths = nodeModulesPathsModule.exports(root, {});
            
            var result = [];
            
            modulePaths.forEach(function (nodeModulesDir) {
                try {
                    
                    fs.readdirSync(nodeModulesDir).forEach(function (file) {
                        if (file == ".bin") return;
                        var fullPath = path.join(nodeModulesDir, file);
                        if (fs.statSync(fullPath).isDirectory()) {
                            result.push({ type: 'local', path: fullPath });
                        }
                    });
                }
                catch (e) {

                }
            });

            callback(null, result);
        }
        else {
            callback('node-modules-paths.js was not found');
        }
    } catch (e) {
        callback(e);
    }
}

module.exports = findNpmPackages;