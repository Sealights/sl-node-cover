var esprima = require('esprima'),
    escodegen = require('escodegen'),
    traverse = require('ast-traverse'),
    astUtils = require('esprima-ast-utils'),
    md5 = require('md5');

var branchNodeTypes = ["IfStatement", "SwitchStatement", "ConditionalExpression", "LogicalExpression"];

function formatLoc(loc) {
    return [loc.line, loc.column];
}

function findLogicalExpressionLeaves(node, leaves) {
    if (node.type === "LogicalExpression") {
            findLogicalExpressionLeaves(node.left, leaves);
            findLogicalExpressionLeaves(node.right, leaves);
    } else {
        leaves.push(node);
    }
}

function calculateFunctionNodeHash(node) {
    var clonedNode = astUtils.clone(node);
    var branchHashes = [];
    traverse(clonedNode, {
        pre: function (node, parent, prop, idx) {
            if (node == clonedNode) return;
            if (node.type == "FunctionDeclaration" || node.type == "FunctionExpression") {
                node.body = { type: "BlockStatement", body: [] };
                node.params = [];
                node.id = { name: '_' };
            }
            if (["IfStatement", "SwitchStatement", "ConditionalExpression"].indexOf(node.type) >= 0) {
                calculateMethodBranches(node, branchHashes);
            }
            if (node.type == "LogicalExpression" && (parent == undefined || parent.type !== "LogicalExpression")) {
                calculateMethodBranches(node, branchHashes);
            }
        }
    });

    var generated = escodegen.generate(clonedNode);
    var hash = md5(generated);
    var methodHashObject = {type: "method", position: formatLoc(clonedNode.loc.start), hash: hash};
    return {
        hash: hash,
        branchHashes: [methodHashObject].concat(branchHashes)
    }
}

function calculateMethodBranches(node, branches) {
    switch (node.type) {
        case "IfStatement":
        case "ConditionalExpression":
            if (node.consequent !== null) {
                branches.push(calculateSingleBranchHash(node.consequent, node.type));
            }
            if (node.alternate == null) {
                // Istanbul counts empty alternates and takes the consequent's location
                node.alternate = {type: "BlockStatement", body: []};
                node.alternate.loc = node.consequent !== null ? node.consequent.loc : node.loc;
                branches.push(calculateSingleBranchHash(node.alternate, node.type));
            }
            else {
                branches.push(calculateSingleBranchHash(node.alternate, node.type));
            }
            break;
        case "SwitchStatement":
            node.cases.forEach(function (caseNode) {
                if (caseNode !== null) {
                    branches.push(calculateSingleBranchHash(caseNode, node.type));
                }
            });
            break;
        case "LogicalExpression":
            var leaves = [];
            findLogicalExpressionLeaves(node, leaves);
            leaves.forEach(function (leafNode) {
                if (leafNode !== null) {
                    branches.push(calculateSingleBranchHash(leafNode, node.type));
                }
            });
            break;
    }
}

function calculateSingleBranchHash(node, nodeType) {
    var clonedNode = astUtils.clone(node);
    var position = formatLoc(node.loc.start);
    traverse(clonedNode, {
        pre: function (node, parent, prop, idx) {
            if (node == clonedNode) return;
            if (node.type == "FunctionDeclaration" || node.type == "FunctionExpression") {
                node.body = { type: "BlockStatement", body: [] };
                node.params = [];
                node.id = { name: '_' };
            }
            switch (node.type) {
                case "IfStatement":
                case "ConditionalExpression":
                    node.consequent = {type: "BlockStatement", body: []};
                    node.alternate = {type: "BlockStatement", body: []};
                    break;
                case "SwitchStatement":
                    node.cases = [];
                    break;
                case "LogicalExpression":
                    node.operator = "";
                    node.left = {type: "Literal", value: null};
                    node.right = {type: "Literal", value: null};
                    break;
            }
        }
    });
    var generated = escodegen.generate(clonedNode);
    var hash = md5(generated);
    return {
        type: nodeType,
        position: position,
        hash: hash
    };
}

/**
 * Creates a new Uint8Array based on two different ArrayBuffers
 * source: https://gist.github.com/72lions/4528834
 * @private
 * @param {ArrayBuffers} buffer1 The first buffer.
 * @param {ArrayBuffers} buffer2 The second buffer.
 * @return {ArrayBuffers} The new ArrayBuffer created out of the two.
 */
function removeHashbangPrefix(bytes) {
    function concatArrays(buffer1, buffer2) {
        var tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
        tmp.set(new Uint8Array(buffer1), 0);
        tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
        return tmp;
    };

    var HASHBANG_BYTES = [35, 33];
    var LINE_COMMENT_BYTES = [47, 47];
    if (bytes.length > 2 && bytes[0] == HASHBANG_BYTES[0] && bytes[1] == HASHBANG_BYTES[1]) { //hashbang
        bytes = concatArrays(new Uint8Array(LINE_COMMENT_BYTES), bytes);//insert two slashes to make that line a comment
    }
    return bytes;
}


function generateFileSignature(filename, bytes) {
    var result = {
        module: { hash: "" },
        methods: []
    };

    filename = filename.replace(/\\/g, '/'); //we want all transients to use unix / instead of windows \

    var ast;

    try {
        bytes = removeHashbangPrefix(bytes);

        //1. Parse the file
        ast = esprima.parse(bytes, {
            loc: true,
            range: true,
            comment: false //No need for those
        });

    } catch (parseException) {
        //TODO: Test
        return { error: "Parse error (1)" };
    }

    try {

        // print AST node types, pre-order (node first, then its children)
        traverse(ast, {
            pre: function (node, parent, prop, idx) {
                if (node.type == "FunctionDeclaration" || node.type == "FunctionExpression") {
                    node.isFunctionNode = true;
                    var methodHashObject = calculateFunctionNodeHash(node);
                    var hash = methodHashObject.hash;
                    var branchHashes = methodHashObject.branchHashes;
                    var start = formatLoc(node.loc.start);
                    var end = formatLoc(node.loc.end);
                    var hasExplicitName = (node.id && node.id.name);
                    var name = node.id && node.id.name;
                    var uniqueName = [name, filename, start.join(',')].join('@');

                    result.methods.push({
                        name: name, //Method that can be presented to the user
                        isAnonymous: !hasExplicitName,
                        start: start,
                        end: end,
                        hash: hash,
                        sigHash: sigHash,
                        uniqueName: uniqueName,
                        branches: branchHashes
                    });
                }
                if (node.hasOwnProperty("isFunctionNode") ||
                    (parent !== null && parent.hasOwnProperty("isFunctionNode"))) {
                    // We want to tag nodes that have a parent that is a method
                    node.isFunctionNode = true;
                }
                if (branchNodeTypes.indexOf(node.type) >= 0 &&
                    (!node.hasOwnProperty("isFunctionNode") || node.isFunctionNode !== true)) {
                    // Nodes that are of branch types and do not belong to a method parent are global branches
                    //TODO Global branches
                }
            }
        });
    }
    catch (traverseException1) {
        return { error: 'Parse error(2)' };
    }
    
    try {
        var bodyHash = calculateFunctionNodeHash(ast).hash;
        result.module.hash = bodyHash;
    } catch (traverseException2) {
        return { error: "Parse error (3)" };
    }
    
    return result;
}

module.exports = {
    generateFileSignature: generateFileSignature, 
    calculateFunctionNodeHash: calculateFunctionNodeHash
};