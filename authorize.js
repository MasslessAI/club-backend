const AWS = require('aws-sdk')
const jwt = require('jsonwebtoken')
const jwkToPem = require('jwk-to-pem')
const axios = require('axios')
const cognito = new AWS.CognitoIdentityServiceProvider({
  apiVersion: '2016-04-18',
  region: 'ca-central-1'
})

/**
 * Returns an IAM policy document for a given user and resource.
 *
 * @method buildIAMPolicy
 * @param {String} userId - user id
 * @param {String} effect  - Allow / Deny
 * @param {String} resource - resource ARN
 * @param {String} context - response context
 * @returns {Object} policyDocument
 */
const buildIAMPolicy = (userId, effect, resource, context) => {
  console.log(`buildIAMPolicy ${userId} ${effect} ${resource}`)
  const policy = {
    principalId: userId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: resource
        }
      ]
    },
    context: context
  }

  console.log(JSON.stringify(policy))
  return policy
}

// Returns a boolean whether or not a user is allowed to call a particular method
// A user with scopes: ['pangolins'] can
// call 'arn:aws:execute-api:ap-southeast-1::random-api-id/dev/GET/pangolins'
const authorizeUser = async accessToken => {
  const decoded = jwt.decode(accessToken, {complete: true})
  if (decoded.payload.iss === 'accounts.google.com') {
    // verify google sso jwt
    const jwk = (await axios.get('https://www.googleapis.com/oauth2/v3/certs')).data
    // find matching kid
    const key = jwk.keys.find(item => item.kid === decoded.header.kid)
    const pem = jwkToPem(key)
    const decodedToken = await jwt.verify(accessToken, pem, { algorithms: ['RS256'] })
    console.log(decodedToken)
    return { isAllowed: true, user: {
      Username: decoded.payload.sub,
      UserAttributes: {
        email: decoded.payload.email,
        name: decoded.payload.name,
        iss: decoded.payload.iss
      }
    }}
  }
  //const user = await cognito.getUser({ AccessToken: accessToken }).promise()
  return { isAllowed: false }
}

/**
 * Authorizer functions are executed before your actual functions.
 * @method authorize
 * @param {String} event.authorizationToken - JWT
 * @throws Returns 401 if the token is invalid or has expired.
 * @throws Returns 403 if the token does not have sufficient permissions.
 */
export const main = async (event, context, callback) => {
  const token = event.authorizationToken

  try {
    const { isAllowed, user } = await authorizeUser(token)

    // Return an IAM policy document for the current endpoint
    const effect = isAllowed ? 'Allow' : 'Deny'
    const userId = user.Username
    const authorizerContext = {
      Username: user.Username,
      UserAttributes: user.UserAttributes
    }
    const policyDocument = buildIAMPolicy(userId, effect, event.methodArn, authorizerContext)

    callback(null, policyDocument)
  } catch (e) {
    console.log(e.message)
  }
}
