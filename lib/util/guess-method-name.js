function guessMethodName(node, anc) {   
    var actualName = node.id && node.id.name;
    var isAnonymous = !actualName;
    var methodType = null;
    var guessName = "(Anonymous)";
    if (isAnonymous) {
        if (anc) {
            switch (anc.type) {
                case "VariableDeclarator":
                    if (anc.id && anc.id.type == "Identifier") {
                        guessName = anc.id.name;
                    }
                    break;
                case "Property":
                    if (anc.key && anc.key.type == "Identifier") {
                        guessName = anc.key.name;
                        methodType = "getterSetter";
                    }
                    break;
                case "AssignmentExpression":
                    if (anc.left && anc.left.type == "MemberExpression" && anc.left.property && anc.left.property.type == "Identifier") {
                        guessName = anc.left.property.name;
                    } else if (anc.left && anc.left.type == "Identifier") {
                        guessName = anc.left.name;
                    }
                    break;
                case "CallExpression":
                    //This is an anonymous function passed to a function, nothing useful to add
                    break; 
                case "MethodDefinition":
                    if (anc.key && anc.key.type == "Identifier") {
                        guessName = anc.key.name;
                        methodType = "method";
                    }
                    break;
                default:
                    break;
            }
        }
    }
    return {
        actualName: actualName, //If the method is anonymous, this will be null/undefined
        name: actualName || guessName,
        type: methodType,
        isAnonymous: isAnonymous
    }
}
module.exports.guessMethodName = guessMethodName;